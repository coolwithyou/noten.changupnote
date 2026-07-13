import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BIZINFO_NORMALIZER_VERSION,
  buildBizInfoDeterministicCriteria,
  buildBizInfoProgramExtractionInput,
  extractBizInfoCriteriaWithAnthropic,
  resolveGrantExtractionManifest,
  type BizInfoProgram,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { loadKStartupAttachmentMarkdowns } from "./kstartupAttachmentMarkdown";

loadMonorepoEnv();

const extract = process.argv.includes("--extract");
const emitDeterministicDrafts = process.argv.includes("--emit-deterministic-drafts");
const confirmation = readArg("confirm");
const limit = boundedInteger(readArg("limit"), 5, 1, 20);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 5_000);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const requestedIds = new Set(csvArg(readArg("sourceIds"), 100));
const outputPath = resolve(readArg("output") ?? (
  emitDeterministicDrafts ? "tmp/bizinfo-deterministic-drafts.jsonl" : "tmp/bizinfo-llm-drafts.jsonl"
));
const skipMarkdown = process.argv.includes("--skip-markdown");

if (extract && emitDeterministicDrafts) {
  throw new Error("--extract and --emit-deterministic-drafts are mutually exclusive");
}

if (extract && confirmation !== "EXTRACT_BIZINFO_CRITERIA") {
  throw new Error("--extract requires --confirm=EXTRACT_BIZINFO_CRITERIA");
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (extract && !apiKey) throw new Error("ANTHROPIC_API_KEY is required for --extract");

const db = getCunoteDb();
try {
  const storage = extract && !skipMarkdown ? createR2ObjectStorageFromEnv() : null;
  const repositories = createDrizzleRepositories<BizInfoProgram>({ dialect: "drizzle", client: db });
  const loaded = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf });
  const candidates = loaded
    .filter((entry) => entry.grant.source === "bizinfo")
    .filter((entry) => requestedIds.size === 0 || requestedIds.has(entry.grant.source_id))
    .filter((entry) => isReextractCandidate(resolveGrantExtractionManifest(entry)))
    .sort((left, right) => inputRichness(right.raw.payload) - inputRichness(left.raw.payload))
    .slice(0, limit);

  if (!extract && !emitDeterministicDrafts) {
    console.log(JSON.stringify({
      mode: "plan",
      databaseWriteMode: false,
      externalCalls: false,
      paidCalls: false,
      loadedGrantCount: loaded.length,
      requestedSourceIds: [...requestedIds],
      candidateCount: candidates.length,
      candidates: candidates.map((entry) => {
        const manifest = resolveGrantExtractionManifest(entry);
        const input = buildBizInfoProgramExtractionInput(entry.raw.payload);
        const deterministic = buildBizInfoDeterministicCriteria(input);
        return {
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
          readiness: manifest.readiness,
          warnings: manifest.warnings,
          currentCriterionCount: entry.criteria.length,
          deterministicCriterionCount: deterministic.length,
          deterministicDimensions: [...new Set(deterministic.map((criterion) => criterion.dimension))],
          convertedAttachmentCount: convertedAttachmentCount(entry.raw.attachments),
          inputCharactersWithoutAttachmentMarkdown: input.text.length,
        };
      }),
      nextStep: "Review the exact sourceIds, then run --extract only with explicit confirmation and API authority.",
    }, null, 2));
  } else if (emitDeterministicDrafts) {
    const drafts = candidates.map((entry) => {
      const input = buildBizInfoProgramExtractionInput(entry.raw.payload);
      return {
        recordType: "bizinfo_criteria_draft",
        source: "bizinfo",
        sourceId: entry.grant.source_id,
        title: entry.grant.title,
        extractorVersion: "bizinfo-structured-backstop-v1",
        model: "deterministic",
        inputSha256: createHash("sha256").update(input.text).digest("hex"),
        criteria: buildBizInfoDeterministicCriteria(input).map((criterion) => ({
          ...criterion,
          needs_review: true,
        })),
        requiredDocuments: [],
        reviewStatus: "draft",
        operationalReady: false,
      } as const;
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, drafts.map((draft) => JSON.stringify(draft)).join("\n") + "\n", "utf8");
    console.log(JSON.stringify({
      mode: "deterministic-draft",
      databaseWriteMode: false,
      externalCalls: false,
      paidCalls: false,
      draftCount: drafts.length,
      criteriaCount: drafts.reduce((sum, draft) => sum + draft.criteria.length, 0),
      outputPath,
      operationalReady: false,
      nextStep: "Export review tasks and complete independent human annotation before publication.",
    }, null, 2));
  } else {
    const drafts: Record<string, unknown>[] = [];
    for (const entry of candidates) {
      try {
        const attachmentLoad = await loadKStartupAttachmentMarkdowns({
          attachments: entry.raw.attachments,
          storage,
        });
        const input = buildBizInfoProgramExtractionInput(entry.raw.payload, {
          attachmentMarkdowns: attachmentLoad.markdowns,
        });
        const result = await extractBizInfoCriteriaWithAnthropic({
          input,
          apiKey: apiKey!,
        });
        drafts.push({
          recordType: "bizinfo_criteria_draft",
          source: "bizinfo",
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
          extractorVersion: BIZINFO_NORMALIZER_VERSION,
          model: result.model,
          inputSha256: createHash("sha256").update(input.text).digest("hex"),
          criteria: result.criteria,
          requiredDocuments: result.requiredDocuments,
          attachmentInput: {
            candidateCount: attachmentLoad.candidateCount,
            loadedCount: attachmentLoad.loadedCount,
            truncatedCount: attachmentLoad.truncatedCount,
            skippedOversizeCount: attachmentLoad.skippedOversizeCount,
            failureCount: attachmentLoad.failures.length,
          },
          usage: result.usage,
          reviewStatus: "draft",
          operationalReady: false,
        });
      } catch (error) {
        drafts.push({
          recordType: "bizinfo_criteria_draft_error",
          source: "bizinfo",
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
          extractorVersion: BIZINFO_NORMALIZER_VERSION,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          operationalReady: false,
        });
      }
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, drafts.map((draft) => JSON.stringify(draft)).join("\n") + "\n", "utf8");
    console.log(JSON.stringify({
      mode: "extract",
      databaseWriteMode: false,
      externalCallCount: candidates.length,
      markdownStorageConfigured: Boolean(storage),
      skipMarkdown,
      draftCount: drafts.filter((draft) => draft.recordType === "bizinfo_criteria_draft").length,
      errorCount: drafts.filter((draft) => draft.recordType === "bizinfo_criteria_draft_error").length,
      outputPath,
      operationalReady: false,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function isReextractCandidate(manifest: ReturnType<typeof resolveGrantExtractionManifest>): boolean {
  return manifest.readiness === "unstructured" || manifest.warnings.some((warning) =>
    warning === "criteria_missing" ||
    warning === "text_only_criterion_present" ||
    warning === "source_field_missing" ||
    warning === "source_section_missing");
}

function convertedAttachmentCount(
  attachments: Parameters<typeof loadKStartupAttachmentMarkdowns>[0]["attachments"],
): number {
  return (attachments ?? []).filter((attachment) =>
    attachment.conversion?.status === "converted" && Boolean(attachment.conversion.markdown_storage_key)).length;
}

function inputRichness(program: BizInfoProgram): number {
  return [
    program.trgetNm,
    program.bsnsSumryCn,
    program.reqstMthPapersCn,
    program.pldirSportRealmLclasCodeNm,
    program.pldirSportRealmMlsfcCodeNm,
  ].reduce<number>((sum, value) => sum + String(value ?? "").length, 0);
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`--sourceIds supports at most ${max} values`);
  return values;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}

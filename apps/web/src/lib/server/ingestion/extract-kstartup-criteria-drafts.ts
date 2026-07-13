import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  extractKStartupCriteriaWithAnthropic,
  KSTARTUP_LLM_EXTRACTOR_VERSION,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { loadKStartupAttachmentMarkdowns } from "./kstartupAttachmentMarkdown";

loadMonorepoEnv();

const extract = process.argv.includes("--extract");
const confirmation = readArg("confirm");
const limit = boundedInteger(readArg("limit"), 5, 1, 20);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 2_000);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const requestedIds = new Set((readArg("sourceIds") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const outputPath = resolve(readArg("output") ?? "tmp/kstartup-llm-drafts.jsonl");
const skipMarkdown = process.argv.includes("--skip-markdown");
if (extract && confirmation !== "EXTRACT_KSTARTUP_CRITERIA") {
  throw new Error("--extract requires --confirm=EXTRACT_KSTARTUP_CRITERIA");
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (extract && !apiKey) throw new Error("ANTHROPIC_API_KEY is required for --extract");

const db = getCunoteDb();
try {
  const storage = extract && !skipMarkdown ? createR2ObjectStorageFromEnv() : null;
  const repositories = createDrizzleRepositories<KStartupAnnouncement>({ dialect: "drizzle", client: db });
  const loaded = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf });
  const candidates = loaded
    .filter((entry) => entry.grant.source === "kstartup")
    .filter((entry) => requestedIds.size === 0 || requestedIds.has(entry.grant.source_id))
    .filter((entry) => entry.criteria.some((criterion) =>
      criterion.operator === "text_only" && (criterion.kind === "required" || criterion.kind === "exclusion")))
    .sort((left, right) => inputRichness(right.raw.payload) - inputRichness(left.raw.payload))
    .slice(0, limit);

  if (!extract) {
    console.log(JSON.stringify({
      mode: "plan",
      writeMode: false,
      externalCalls: false,
      loadedGrantCount: loaded.length,
      requestedSourceIds: [...requestedIds],
      candidateCount: candidates.length,
      candidates: candidates.map((entry) => ({
        sourceId: entry.grant.source_id,
        title: entry.grant.title,
        textOnlyDimensions: [...new Set(entry.criteria
          .filter((criterion) => criterion.operator === "text_only")
          .map((criterion) => criterion.dimension))],
        hasDetail: Boolean(entry.raw.payload.detail),
        convertedAttachmentCount: convertedAttachmentCount(entry.raw.attachments),
      })),
    }, null, 2));
  } else {
    const drafts: Record<string, unknown>[] = [];
    for (const entry of candidates) {
      try {
        const attachmentLoad = await loadKStartupAttachmentMarkdowns({
          attachments: entry.raw.attachments,
          storage,
        });
        const result = await extractKStartupCriteriaWithAnthropic({
          announcement: entry.raw.payload,
          attachmentMarkdowns: attachmentLoad.markdowns,
          apiKey: apiKey!,
        });
        drafts.push({
          recordType: "kstartup_criteria_draft",
          source: "kstartup",
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
          extractorVersion: KSTARTUP_LLM_EXTRACTOR_VERSION,
          model: result.model,
          inputSha256: createHash("sha256").update(result.input.text).digest("hex"),
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
          recordType: "kstartup_criteria_draft_error",
          source: "kstartup",
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
          extractorVersion: KSTARTUP_LLM_EXTRACTOR_VERSION,
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
      draftCount: drafts.filter((draft) => draft.recordType === "kstartup_criteria_draft").length,
      errorCount: drafts.filter((draft) => draft.recordType === "kstartup_criteria_draft_error").length,
      outputPath,
      operationalReady: false,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function convertedAttachmentCount(attachments: Parameters<typeof loadKStartupAttachmentMarkdowns>[0]["attachments"]): number {
  return (attachments ?? []).filter((attachment) =>
    attachment.conversion?.status === "converted" && Boolean(attachment.conversion.markdown_storage_key)).length;
}

function inputRichness(announcement: KStartupAnnouncement): number {
  return [
    announcement.aply_trgt,
    announcement.aply_trgt_ctnt,
    announcement.aply_excl_trgt_ctnt,
    announcement.prfn_matr,
    announcement.detail?.apply_method_text,
    announcement.detail?.submit_documents_text,
  ].reduce<number>((sum, value) => sum + String(value ?? "").length, 0);
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}

import { and, eq, inArray } from "drizzle-orm";
import type {
  GrantCriterion,
  GrantRequiredDocument,
  NormalizedGrant,
} from "@cunote/contracts";
import {
  BIZINFO_NORMALIZER_VERSION,
  buildBizInfoProgramExtractionInput,
  extractBizInfoCriteriaWithAnthropic,
  fetchBizInfoPrograms,
  normalizeBizInfoProgram,
  type BizInfoProgram,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  planGrantArchivePublication,
  type ExistingGrantRawHash,
  type GrantArchivePlan,
} from "./archivePlan";
import { buildBizInfoSampleEntries } from "./bizinfoSample";
import { publishBizInfoGrants } from "./bizinfoPublisher";
import { archiveBizInfoProgramAttachments, type GrantAttachmentArchiveBundle } from "./grantAttachmentArchive";
import { hashGrantRawPayload } from "./grantRawHash";

const TEXT_ONLY_FALLBACK_VERSION = "bizinfo-text-only-fallback-v1";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const source = readEnum(readArg("source") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_SOURCE, ["sample", "live"], "sample");
const limit = optionalBoundedInteger(readArg("limit") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_LIMIT, source === "live" ? 20 : 1, 1, 10_000);
const offset = boundedInteger(readArg("offset") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_OFFSET, 0, 0, 100_000);
const sourceId = readArg("sourceId") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_SOURCE_ID;
const write = hasFlag("write") || process.env.CUNOTE_BIZINFO_ARCHIVE_WRITE === "true";
const compareDb = write || hasFlag("compare-db") || process.env.CUNOTE_BIZINFO_ARCHIVE_COMPARE_DB === "true";
const skipUnchanged = !hasFlag("publish-unchanged") && process.env.CUNOTE_BIZINFO_ARCHIVE_PUBLISH_UNCHANGED !== "true";
const allowTextOnlyFallback = hasFlag("allow-text-only-fallback") ||
  process.env.CUNOTE_BIZINFO_ARCHIVE_ALLOW_TEXT_ONLY_FALLBACK === "true";
const extractionMode = readEnum(
  readArg("extraction") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_EXTRACTION,
  ["auto", "anthropic", "text_only"],
  "auto",
);
const archiveAttachments = !hasFlag("skip-attachments") && (
  hasFlag("archive-attachments") ||
  process.env.CUNOTE_BIZINFO_ARCHIVE_ATTACHMENTS === "true" ||
  (write && source === "live")
);
const convertAttachments = archiveAttachments && !hasFlag("skip-attachment-conversion") &&
  process.env.CUNOTE_BIZINFO_ARCHIVE_CONVERT_ATTACHMENTS !== "false";
const autoInstallPyhwp = readArg("autoInstallPyhwp") !== "false" &&
  process.env.CUNOTE_BIZINFO_ARCHIVE_AUTO_INSTALL_PYHWP !== "false";
const allowAttachmentFailures = hasFlag("allow-attachment-failures") ||
  process.env.CUNOTE_BIZINFO_ARCHIVE_ALLOW_ATTACHMENT_FAILURES === "true";
const collectedAt = dateArg(readArg("collectedAt") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_COLLECTED_AT) ?? new Date();
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTROPHIC_API_KEY?.trim();
const anthropicModel = readArg("model") ?? process.env.ANTHROPIC_MODEL;
const db = compareDb ? getCunoteDb() : null;
const storage = archiveAttachments ? createR2ObjectStorageFromEnv() : null;

try {
  const result = await archiveBizInfo({
    db,
    source,
    limit,
    offset,
    sourceId,
    write,
    compareDb,
    skipUnchanged,
    allowTextOnlyFallback,
    extractionMode,
    archiveAttachments,
    convertAttachments,
    autoInstallPyhwp,
    allowAttachmentFailures,
    collectedAt,
    anthropicApiKey,
    anthropicModel,
    storage,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeCunoteDb();
}

interface ArchiveBizInfoInput {
  db: CunoteDb | null;
  source: "sample" | "live";
  limit: number;
  offset: number;
  sourceId: string | undefined;
  write: boolean;
  compareDb: boolean;
  skipUnchanged: boolean;
  allowTextOnlyFallback: boolean;
  extractionMode: "auto" | "anthropic" | "text_only";
  archiveAttachments: boolean;
  convertAttachments: boolean;
  autoInstallPyhwp: boolean;
  allowAttachmentFailures: boolean;
  collectedAt: Date;
  anthropicApiKey: string | undefined;
  anthropicModel: string | undefined;
  storage: R2ObjectStorage | null;
}

interface ArchiveBizInfoResult {
  dryRun: boolean;
  source: "sample" | "live";
  compareDb: boolean;
  skipUnchanged: boolean;
  extractionMode: string;
  allowTextOnlyFallback: boolean;
  archiveAttachments: boolean;
  convertAttachments: boolean;
  fetchedCount: number;
  selectedCount: number;
  extractionCandidateCount: number;
  publishedCount: number;
  collectedAt: string;
  plan: Omit<GrantArchivePlan, "rawHashes"> & { rawHashCount: number };
  extraction: {
    anthropicCount: number;
    textOnlyFallbackCount: number;
    skippedUnchangedCount: number;
    failureCount: number;
    failures: Array<{ sourceId: string; message: string }>;
  };
  attachments: {
    archivedCount: number;
    convertedCount: number;
    skippedConversionCount: number;
    attachmentRefreshCount: number;
    failureCount: number;
    failures: Array<{ sourceId: string; filename: string; url: string | null; message: string }>;
  };
}

interface BizInfoExtractionArtifact {
  entry: NormalizedGrant<BizInfoProgram>;
  extraction: {
    inputRef: string;
    output: Record<string, unknown>;
    confidence: number;
    status: "auto" | "review";
    modelVer: string;
    promptVer: string;
  };
  method: "anthropic" | "text_only";
  attachments: GrantAttachmentArchiveBundle;
}

async function archiveBizInfo(input: ArchiveBizInfoInput): Promise<ArchiveBizInfoResult> {
  if (input.write && !input.db) throw new Error("--write requires database access.");
  if (input.source === "live" && input.extractionMode === "anthropic" && !input.anthropicApiKey) {
    throw new Error("기업마당 Anthropic 추출에는 ANTHROPIC_API_KEY가 필요합니다.");
  }
  if (input.source === "live" && input.extractionMode === "text_only" && !input.allowTextOnlyFallback) {
    throw new Error("text_only fallback publish는 --allow-text-only-fallback 으로 명시해야 합니다.");
  }
  if (input.archiveAttachments && !input.storage) {
    throw new Error("첨부 아카이브에는 R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL 설정이 필요합니다.");
  }

  const programs = input.source === "live"
    ? await readLivePrograms()
    : buildBizInfoSampleEntries({ asOf: input.collectedAt, collectedAt: input.collectedAt })
      .map((entry) => entry.raw.payload);
  const selectedPrograms = selectPrograms(programs, input);
  const existingHashes = input.db ? await readExistingGrantRawHashes(input.db, selectedPrograms) : [];
  const rawPlan = planRawPrograms(selectedPrograms, existingHashes, {
    skipUnchanged: input.skipUnchanged,
    archiveAttachments: input.archiveAttachments,
  });
  const extractionCandidates = selectedPrograms.filter((program) =>
    rawPlan.publishableSourceIds.includes(program.pblancId)
  );

  const artifacts: BizInfoExtractionArtifact[] = [];
  const failures: Array<{ sourceId: string; message: string }> = [];
  for (const program of extractionCandidates) {
    try {
      artifacts.push(await buildBizInfoArtifact(program, input));
    } catch (error) {
      failures.push({
        sourceId: program.pblancId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const entries = artifacts.map((artifact) => artifact.entry);
  const plan = planGrantArchivePublication("bizinfo", entries, existingHashes, {
    skipUnchanged: input.skipUnchanged,
  });
  const publishableEntries = selectPublishableEntries(entries, plan, rawPlan.attachmentRefreshSourceIds);
  const adjustedPlan = adjustPlanForForcedPublish(plan, publishableEntries);

  if (input.write && input.db) {
    if (publishableEntries.length > 0) {
      await publishBizInfoGrants(input.db, publishableEntries, {
        page: 1,
        collectedAt: input.collectedAt,
      });
      await writeExtractionLogs(input.db, artifacts, publishableEntries);
    } else {
      await updateSourceCursor(input.db, input.collectedAt);
    }
  }

  return {
    dryRun: !input.write,
    source: input.source,
    compareDb: input.compareDb,
    skipUnchanged: input.skipUnchanged,
    extractionMode: input.extractionMode,
    allowTextOnlyFallback: input.allowTextOnlyFallback,
    archiveAttachments: input.archiveAttachments,
    convertAttachments: input.convertAttachments,
    fetchedCount: programs.length,
    selectedCount: selectedPrograms.length,
    extractionCandidateCount: extractionCandidates.length,
    publishedCount: input.write ? publishableEntries.length : 0,
    collectedAt: input.collectedAt.toISOString(),
    plan: summarizePlan({
      ...adjustedPlan,
      fetchedCount: selectedPrograms.length,
      newCount: rawPlan.newCount,
      changedCount: rawPlan.changedCount,
      unchangedCount: rawPlan.unchangedCount,
      publishableCount: publishableEntries.length,
      publishableSourceIds: publishableEntries.map((entry) => entry.raw.source_id),
      unchangedSourceIds: rawPlan.unchangedSourceIds,
      changedSourceIds: rawPlan.changedSourceIds,
      newSourceIds: rawPlan.newSourceIds,
    }),
    extraction: {
      anthropicCount: artifacts.filter((artifact) => artifact.method === "anthropic").length,
      textOnlyFallbackCount: artifacts.filter((artifact) => artifact.method === "text_only").length,
      skippedUnchangedCount: rawPlan.unchangedCount,
      failureCount: failures.length,
      failures,
    },
    attachments: summarizeAttachmentArchives(artifacts, rawPlan.attachmentRefreshSourceIds.length),
  };
}

async function readLivePrograms(): Promise<BizInfoProgram[]> {
  const serviceKey = process.env.BIZINFO_SERVICE_KEY?.trim();
  if (!serviceKey) throw new Error("BIZINFO_SERVICE_KEY가 필요합니다.");
  const payload = await fetchBizInfoPrograms({ serviceKey });
  return payload.jsonArray;
}

function selectPrograms(programs: BizInfoProgram[], input: Pick<ArchiveBizInfoInput, "sourceId" | "offset" | "limit">): BizInfoProgram[] {
  const filtered = input.sourceId
    ? programs.filter((program) => program.pblancId === input.sourceId)
    : programs;
  return filtered.slice(input.offset, input.offset + input.limit);
}

async function buildBizInfoArtifact(
  program: BizInfoProgram,
  input: ArchiveBizInfoInput,
): Promise<BizInfoExtractionArtifact> {
  if (input.source === "sample") {
    const [entry] = buildBizInfoSampleEntries({ asOf: input.collectedAt, collectedAt: input.collectedAt });
    if (!entry) throw new Error("기업마당 샘플 엔트리가 없습니다.");
    return {
      entry,
      method: "text_only",
      attachments: emptyAttachmentArchiveBundle(entry.raw.attachments ?? []),
      extraction: {
        inputRef: `bizinfo:${entry.raw.source_id}:sample`,
        output: {
          criteria: entry.criteria,
          required_documents: entry.grant.required_documents ?? [],
        },
        confidence: entry.grant.overall_confidence,
        status: "auto",
        modelVer: "sample-fixture",
        promptVer: entry.grant.prompt_ver ?? BIZINFO_NORMALIZER_VERSION,
      },
    };
  }

  const archivedAttachments = await archiveBizInfoProgramAttachments(program, {
    enabled: input.archiveAttachments,
    convertHwp: input.convertAttachments,
    autoInstallPyhwp: input.autoInstallPyhwp,
    allowFailures: input.allowAttachmentFailures,
    storage: input.storage,
    collectedAt: input.collectedAt,
  });
  const inputDoc = buildBizInfoProgramExtractionInput(program, {
    attachmentMarkdowns: archivedAttachments.attachmentMarkdowns,
  });
  const shouldUseAnthropic = input.extractionMode === "anthropic" ||
    (input.extractionMode === "auto" && Boolean(input.anthropicApiKey));

  if (shouldUseAnthropic) {
    if (!input.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY가 필요합니다.");
    const result = await extractBizInfoCriteriaWithAnthropic({
      input: inputDoc,
      apiKey: input.anthropicApiKey,
      ...(input.anthropicModel ? { model: input.anthropicModel } : {}),
    });
    const entry = normalizeBizInfoProgram(program, result.criteria, {
      asOf: input.collectedAt,
      attachmentMarkdowns: archivedAttachments.attachmentMarkdowns,
      attachments: archivedAttachments.attachments,
      collectedAt: input.collectedAt,
      model: result.model,
      requiredDocuments: result.requiredDocuments,
    });
    return {
      entry,
      method: "anthropic",
      attachments: archivedAttachments,
      extraction: {
        inputRef: `bizinfo:${program.pblancId}:anthropic`,
        output: {
          criteria: result.criteria,
          required_documents: result.requiredDocuments,
          usage: result.usage,
        },
        confidence: entry.grant.overall_confidence,
        status: result.criteria.some((criterion) => criterion.needs_review) ? "review" : "auto",
        modelVer: result.model,
        promptVer: BIZINFO_NORMALIZER_VERSION,
      },
    };
  }

  if (!input.allowTextOnlyFallback) {
    throw new Error("ANTHROPIC_API_KEY가 없으면 --allow-text-only-fallback 이 필요합니다.");
  }

  const criteria = buildTextOnlyFallbackCriteria(program, inputDoc.text);
  const entry = normalizeBizInfoProgram(program, criteria, {
    asOf: input.collectedAt,
    attachmentMarkdowns: archivedAttachments.attachmentMarkdowns,
    attachments: archivedAttachments.attachments,
    collectedAt: input.collectedAt,
    model: TEXT_ONLY_FALLBACK_VERSION,
    requiredDocuments: [],
  });
  return {
    entry,
    method: "text_only",
    attachments: archivedAttachments,
    extraction: {
      inputRef: `bizinfo:${program.pblancId}:text_only`,
      output: {
        criteria,
        required_documents: entry.grant.required_documents ?? [],
        fallback_reason: "anthropic_unavailable_or_disabled",
      },
      confidence: entry.grant.overall_confidence,
      status: "review",
      modelVer: TEXT_ONLY_FALLBACK_VERSION,
      promptVer: TEXT_ONLY_FALLBACK_VERSION,
    },
  };
}

function buildTextOnlyFallbackCriteria(program: BizInfoProgram, text: string): GrantCriterion[] {
  const sourceSpan = firstNonEmpty([
    program.trgetNm,
    program.bsnsSumryCn,
    program.reqstMthPapersCn,
    text,
  ]);

  return [{
    id: `bizinfo:${program.pblancId}:text-only-fallback-1`,
    grant_id: program.pblancId,
    dimension: "other",
    operator: "text_only",
    kind: "required",
    value: {
      note: "기업마당 공고의 상세 신청자격을 원문 기준으로 확인해야 합니다.",
    },
    confidence: 0.35,
    source_span: sourceSpan.slice(0, 240),
    raw_text: text.slice(0, 2000),
    source_field: "bizinfo_text_only_fallback",
    needs_review: true,
    parser_version: TEXT_ONLY_FALLBACK_VERSION,
  }];
}

async function readExistingGrantRawHashes(
  db: CunoteDb,
  programs: BizInfoProgram[],
): Promise<ExistingBizInfoRawState[]> {
  const sourceIds = [...new Set(programs.map((program) => program.pblancId))];
  if (sourceIds.length === 0) return [];
  const rows = await db
    .select({
      sourceId: schema.grantRaw.sourceId,
      rawHash: schema.grantRaw.rawHash,
      attachments: schema.grantRaw.attachments,
    })
    .from(schema.grantRaw)
    .where(and(
      eq(schema.grantRaw.source, "bizinfo"),
      inArray(schema.grantRaw.sourceId, sourceIds),
    ));
  return rows;
}

interface ExistingBizInfoRawState extends ExistingGrantRawHash {
  attachments: Array<Record<string, unknown>> | null;
}

function planRawPrograms(
  programs: BizInfoProgram[],
  existingHashes: ExistingBizInfoRawState[],
  options: { skipUnchanged: boolean; archiveAttachments: boolean },
): Pick<
  GrantArchivePlan,
  "newCount" | "changedCount" | "unchangedCount" | "publishableCount" |
  "newSourceIds" | "changedSourceIds" | "unchangedSourceIds" | "publishableSourceIds"
> & { attachmentRefreshSourceIds: string[] } {
  const existingBySourceId = new Map(existingHashes.map((row) => [row.sourceId, row.rawHash]));
  const existingStateBySourceId = new Map(existingHashes.map((row) => [row.sourceId, row]));
  const newSourceIds: string[] = [];
  const changedSourceIds: string[] = [];
  const unchangedSourceIds: string[] = [];
  const publishableSourceIds: string[] = [];
  const attachmentRefreshSourceIds: string[] = [];

  for (const program of programs) {
    const hash = hashGrantRawPayload(program);
    const existingHash = existingBySourceId.get(program.pblancId);
    const isKnown = existingBySourceId.has(program.pblancId);
    const isUnchanged = isKnown && existingHash === hash;
    if (!isKnown) newSourceIds.push(program.pblancId);
    if (isKnown && !isUnchanged) changedSourceIds.push(program.pblancId);
    if (isUnchanged) unchangedSourceIds.push(program.pblancId);
    const needsAttachmentRefresh = options.archiveAttachments &&
      needsAttachmentArchive(program, existingStateBySourceId.get(program.pblancId));
    if (needsAttachmentRefresh) attachmentRefreshSourceIds.push(program.pblancId);
    if (!options.skipUnchanged || !isUnchanged || needsAttachmentRefresh) {
      publishableSourceIds.push(program.pblancId);
    }
  }

  return {
    newCount: newSourceIds.length,
    changedCount: changedSourceIds.length,
    unchangedCount: unchangedSourceIds.length,
    publishableCount: publishableSourceIds.length,
    newSourceIds,
    changedSourceIds,
    unchangedSourceIds,
    publishableSourceIds,
    attachmentRefreshSourceIds,
  };
}

function needsAttachmentArchive(program: BizInfoProgram, existing: ExistingBizInfoRawState | undefined): boolean {
  const sourceAttachments = buildBizInfoProgramExtractionInput(program).metadata.attachments
    .filter((attachment) => attachment.url);
  if (sourceAttachments.length === 0) return false;
  const existingAttachments = existing?.attachments ?? [];
  if (existingAttachments.length === 0) return true;

  return sourceAttachments.some((attachment) => {
    const filename = cleanText(attachment.filename);
    const url = cleanText(attachment.url);
    const match = existingAttachments.find((row) => {
      const value = row as Record<string, unknown>;
      return cleanText(value.filename as string | undefined) === filename &&
        (
          cleanText(value.source_uri as string | undefined) === url ||
          cleanText(value.url as string | undefined) === url ||
          cleanText(value.archive_url as string | undefined) === url
        );
    });
    if (!match) return true;
    const value = match as Record<string, unknown>;
    return !cleanText(value.archive_url as string | undefined) && !cleanText(value.storage_key as string | undefined);
  });
}

function selectPublishableEntries(
  entries: Array<NormalizedGrant<BizInfoProgram>>,
  plan: Pick<GrantArchivePlan, "publishableSourceIds">,
  forcedSourceIds: string[],
): Array<NormalizedGrant<BizInfoProgram>> {
  const publishable = new Set([...plan.publishableSourceIds, ...forcedSourceIds]);
  return entries.filter((entry) => publishable.has(entry.raw.source_id));
}

function adjustPlanForForcedPublish(
  plan: GrantArchivePlan,
  publishableEntries: Array<NormalizedGrant<BizInfoProgram>>,
): GrantArchivePlan {
  const publishableSourceIds = publishableEntries.map((entry) => entry.raw.source_id);
  return {
    ...plan,
    publishableCount: publishableSourceIds.length,
    publishableCriteriaCount: publishableEntries.reduce((sum, entry) => sum + entry.criteria.length, 0),
    publishableSourceIds,
  };
}

function summarizeAttachmentArchives(
  artifacts: BizInfoExtractionArtifact[],
  attachmentRefreshCount: number,
): ArchiveBizInfoResult["attachments"] {
  return {
    archivedCount: artifacts.reduce((sum, artifact) => sum + artifact.attachments.archivedCount, 0),
    convertedCount: artifacts.reduce((sum, artifact) => sum + artifact.attachments.convertedCount, 0),
    skippedConversionCount: artifacts.reduce((sum, artifact) => sum + artifact.attachments.skippedConversionCount, 0),
    attachmentRefreshCount,
    failureCount: artifacts.reduce((sum, artifact) => sum + artifact.attachments.failureCount, 0),
    failures: artifacts.flatMap((artifact) =>
      artifact.attachments.failures.map((failure) => ({
        sourceId: artifact.entry.raw.source_id,
        ...failure,
      }))
    ),
  };
}

function emptyAttachmentArchiveBundle(
  attachments: NonNullable<NormalizedGrant<BizInfoProgram>["raw"]["attachments"]>,
): GrantAttachmentArchiveBundle {
  return {
    attachments,
    attachmentMarkdowns: [],
    archivedCount: 0,
    convertedCount: 0,
    skippedConversionCount: 0,
    failureCount: 0,
    failures: [],
  };
}

async function writeExtractionLogs(
  db: CunoteDb,
  artifacts: BizInfoExtractionArtifact[],
  publishableEntries: Array<NormalizedGrant<BizInfoProgram>>,
): Promise<void> {
  const publishableIds = new Set(publishableEntries.map((entry) => entry.raw.source_id));
  const sourceIds = [...publishableIds];
  if (sourceIds.length === 0) return;

  const grantRows = await db
    .select({
      id: schema.grants.id,
      sourceId: schema.grants.sourceId,
    })
    .from(schema.grants)
    .where(and(
      eq(schema.grants.source, "bizinfo"),
      inArray(schema.grants.sourceId, sourceIds),
    ));
  const grantIdBySourceId = new Map(grantRows.map((row) => [row.sourceId, row.id]));
  const rows = artifacts
    .filter((artifact) => publishableIds.has(artifact.entry.raw.source_id))
    .map((artifact) => ({
      grantId: grantIdBySourceId.get(artifact.entry.raw.source_id) ?? null,
      inputRef: artifact.extraction.inputRef,
      output: artifact.extraction.output,
      confidence: artifact.extraction.confidence,
      status: artifact.extraction.status,
      modelVer: artifact.extraction.modelVer,
      promptVer: artifact.extraction.promptVer,
    }));

  if (rows.length > 0) await db.insert(schema.extractionLog).values(rows);
}

async function updateSourceCursor(db: CunoteDb, collectedAt: Date): Promise<void> {
  await db
    .insert(schema.sourceCursor)
    .values({
      source: "bizinfo",
      lastPage: 1,
      lastCollectedAt: collectedAt,
    })
    .onConflictDoUpdate({
      target: schema.sourceCursor.source,
      set: {
        lastPage: 1,
        lastCollectedAt: collectedAt,
      },
    });
}

function summarizePlan(plan: GrantArchivePlan): ArchiveBizInfoResult["plan"] {
  const { rawHashes, ...rest } = plan;
  return {
    ...rest,
    rawHashCount: rawHashes.length,
  };
}

function firstNonEmpty(values: Array<string | null | undefined>): string {
  return values.map((value) => cleanText(value)).find(Boolean) ?? "기업마당 원문 확인 필요";
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readEnum<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value: ${value}. Use ${values.join("|")}.`);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid bounded integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function optionalBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  return boundedInteger(value, fallback, min, max);
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function printHelp() {
  console.log(`Usage: pnpm archive:bizinfo -- [options]

Archives BizInfo support programs through the normalized grant contract.
Default mode is dry-run. Add --write to persist.

Options:
  --source=sample|live
  --limit=20
  --offset=0
  --sourceId=PBLN_...
  --compare-db
  --write
  --publish-unchanged
  --extraction=auto|anthropic|text_only
  --allow-text-only-fallback
  --archive-attachments
  --skip-attachments
  --skip-attachment-conversion
  --allow-attachment-failures
  --autoInstallPyhwp=false
  --model=claude...
  --collectedAt=2026-06-27T00:00:00Z

Environment:
  BIZINFO_SERVICE_KEY
  ANTHROPIC_API_KEY
  R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL
  CUNOTE_BIZINFO_ARCHIVE_SOURCE=sample
  CUNOTE_BIZINFO_ARCHIVE_WRITE=true
  CUNOTE_BIZINFO_ARCHIVE_ATTACHMENTS=true
`);
}

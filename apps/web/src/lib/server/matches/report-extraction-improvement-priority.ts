import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import {
  parseV3AnnotationJsonl,
  planExtractionImprovements,
  projectBusinessNumberInitialProfile,
  resolveGrantExtractionManifest,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import * as schema from "../db/schema";
import { selectKStartupAttachmentsForArchive } from "../ingestion/kstartupAttachmentSelection";
import {
  emptyAttachmentState,
  operationalActionFor,
  type OperationalAttachmentState,
} from "./extractionOperationalAction";

loadMonorepoEnv();
const asOf = dateArg(readArg("asOf")) ?? new Date();
const limit = boundedInteger(readArg("limit"), 2_000, 1, 5_000);
const samples = boundedInteger(readArg("samples"), 50, 0, 200);
const trackedSourceIds = csvArg(readArg("trackSourceIds"), 100);
const trackedSource = readArg("trackSource");
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl");
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies.flatMap((record) =>
  record.businessKind === "individual" || record.businessKind === "corporation"
    ? [projectBusinessNumberInitialProfile(record.profile, record.businessKind)]
    : []);
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ asOf, limit });
  const plan = planExtractionImprovements({ grants, companies, asOf });
  const attachmentStates = await loadOperationalAttachmentStates(
    db,
    plan.candidates.map((candidate) => candidate.sourceId),
  );
  const operationalCandidates = plan.candidates.map((candidate) => {
    const state = attachmentStates.get(`${candidate.source}:${candidate.sourceId}`) ?? emptyAttachmentState();
    const grant = grants.find((entry) =>
      entry.grant.source === candidate.source && entry.grant.source_id === candidate.sourceId)!;
    const manifest = resolveGrantExtractionManifest(grant);
    const archiveableAttachmentCount = selectKStartupAttachmentsForArchive(
      (grant.raw.attachments ?? []).filter((attachment) => !attachment.storage_key || !attachment.sha256),
      10,
    ).length;
    const unarchivedAttachmentCount = (grant.raw.attachments ?? []).filter((attachment) =>
      !attachment.storage_key || !attachment.sha256).length;
    const ocrableAttachmentCount = (grant.raw.attachments ?? []).filter((attachment) =>
      (!attachment.storage_key || !attachment.sha256) && /\.(?:png|jpe?g)$/i.test(attachment.filename)).length;
    return {
      ...candidate,
      operationalAction: operationalActionFor(
        candidate.actions,
        manifest.attachmentsExpected,
        state,
        archiveableAttachmentCount,
        unarchivedAttachmentCount,
        ocrableAttachmentCount,
      ),
      archiveableAttachmentCount,
      ocrableAttachmentCount,
      unsupportedExtensions: (grant.raw.attachments ?? [])
        .filter((attachment) => !attachment.storage_key || !attachment.sha256)
        .map((attachment) => extname(attachment.filename).toLowerCase() || "(none)")
        .filter((extension) => ![".hwp", ".hwpx", ".pdf", ".docx", ".txt"].includes(extension)),
      attachmentInputSummary: {
        rawCount: grant.raw.attachments?.length ?? 0,
        unarchivedCount: unarchivedAttachmentCount,
        filenames: (grant.raw.attachments ?? []).slice(0, 5).map((attachment) => attachment.filename),
      },
      attachmentState: state,
    };
  });
  const priorityBatches = buildPriorityBatches(operationalCandidates, 20);
  const trackedCandidates = trackedSourceIds.map((sourceId) => {
    const grant = grants.find((entry) =>
      entry.grant.source_id === sourceId && (!trackedSource || entry.grant.source === trackedSource));
    const candidate = operationalCandidates.find((entry) =>
      entry.sourceId === sourceId && (!trackedSource || entry.source === trackedSource));
    const manifest = grant ? resolveGrantExtractionManifest(grant) : null;
    return {
      sourceId,
      activeGrantFound: Boolean(grant),
      source: grant?.grant.source ?? null,
      operationalAction: candidate?.operationalAction ?? "none",
      eligibleBlockedCompanyCount: candidate?.eligibleBlockedCompanyCount ?? 0,
      priorityScore: candidate?.priorityScore ?? 0,
      extractionReadiness: manifest?.readiness ?? null,
      extractionWarnings: manifest?.warnings ?? [],
      attachmentState: candidate?.attachmentState ?? emptyAttachmentState(),
    };
  });
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    companyFixtureKind: "synthetic_business_number_initial_projection",
    operationalAccuracyEvidence: false,
    grantCount: plan.grantCount,
    companyCount: plan.companyCount,
    candidateCount: plan.candidateCount,
    totalEligibleBlockedCompanyCount: plan.totalEligibleBlockedCompanyCount,
    actionCounts: plan.actionCounts,
    operationalActionCounts: histogram(operationalCandidates.map((candidate) => candidate.operationalAction)),
    unsupportedAttachmentExtensions: histogram(operationalCandidates
      .filter((candidate) => candidate.operationalAction === "inspect_unsupported_attachments")
      .flatMap((candidate) => candidate.unsupportedExtensions)),
    ocrImageExtensions: histogram(operationalCandidates
      .filter((candidate) => candidate.operationalAction === "ocr_images")
      .flatMap((candidate) => candidate.unsupportedExtensions)),
    bySource: plan.bySource,
    priorityBatches,
    trackedCandidates,
    samples: operationalCandidates.slice(0, samples),
    executionContracts: {
      kstartupArchive: "pnpm backfill:kstartup-attachments -- --sourceIds=<csv> --limit=<n> (dry-run; write requires ARCHIVE_KSTARTUP_ATTACHMENTS confirmation)",
      kstartupAttachmentMetadata: "pnpm backfill:kstartup-details -- --sourceIds=<csv> --limit=<n> (dry-run; write requires BACKFILL_KSTARTUP_DETAILS confirmation)",
      unsupportedAttachments: "pnpm inspect:unsupported-grant-attachments -- --source=<source> --sourceIds=<csv> --limit=<n> (read-only; current remainder is image-only and stays review-blocked without OCR)",
      imageOcr: "pnpm probe:grant-image-ocr -- --provider=macos_vision|paddleocr --source=<source> --sourceIds=<csv> --limit=<n> (read-only); archive write additionally requires the same --imageOcr provider and the source archive confirmation",
      bizinfoArchive: "pnpm backfill:bizinfo-attachments -- --sourceIds=<csv> --limit=<n> (dry-run; write requires ARCHIVE_BIZINFO_ATTACHMENTS confirmation)",
      bizinfoReextract: "pnpm extract:bizinfo-criteria-drafts -- --sourceIds=<csv> --limit=<n> (read-only planning; paid extraction requires --extract --confirm=EXTRACT_BIZINFO_CRITERIA and only emits review drafts)",
      archivedSurfaceRegistration: "pnpm backfill:attachment-surfaces -- --source=<source> --sourceIds=<csv> --limit=<n> (dry-run; write requires REGISTER_ATTACHMENT_SURFACES confirmation)",
      attachmentLinkageRepair: "pnpm repair:attachment-surface-links -- --source=<source> --sourceIds=<csv> --limit=<n> (dry-run; write requires REPAIR_ATTACHMENT_SURFACE_LINKS confirmation)",
      conversionPoll: "pnpm conversion:poll -- --source=<source> --sourceIds=<csv> --limit=<n> (dry-run; write requires POLL_CONVERSION_JOBS confirmation)",
      kstartupReextract: "pnpm extract:kstartup-criteria-drafts -- --limit=<n> (planning only unless explicit extract confirmation)",
      reviewedPublication: "pnpm publish:reviewed-grant-annotations -- --input=<reviewed-jsonl> (dry-run)",
    },
    reminders: [
      "priority is potential user impact, not extraction accuracy evidence",
      "eligibleBlockedCompanyCount is the strongest immediate recommendable unlock signal",
      "conditionalCompanyCount estimates question-path enablement and is discounted in priority",
      "all write and external extraction actions remain separately confirmed",
    ],
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--value must be ${min}..${max}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --asOf: ${value}`);
  return date;
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`--trackSourceIds supports at most ${max} values`);
  return values;
}

function buildPriorityBatches(
  candidates: Array<{
    source: string;
    sourceId: string;
    operationalAction: string;
    eligibleBlockedCompanyCount: number;
    priorityScore: number;
    readiness: string;
    warnings: string[];
    attachmentState: OperationalAttachmentState;
  }>,
  batchSize: number,
) {
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.operationalAction}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.entries()].map(([key, values]) => {
    const [source, action] = key.split(":");
    const selected = values.slice(0, batchSize);
    return {
      source,
      action,
      totalCandidateCount: values.length,
      selectedCount: selected.length,
      eligibleBlockedCompanyCount: selected.reduce((sum, item) => sum + item.eligibleBlockedCompanyCount, 0),
      priorityScoreSum: selected.reduce((sum, item) => sum + item.priorityScore, 0),
      sourceIds: selected.map((item) => item.sourceId),
      selectedCandidates: selected.map((item) => ({
        sourceId: item.sourceId,
        operationalAction: item.operationalAction,
        eligibleBlockedCompanyCount: item.eligibleBlockedCompanyCount,
        priorityScore: item.priorityScore,
        extractionReadiness: item.readiness,
        extractionWarnings: item.warnings,
        attachmentState: item.attachmentState,
      })),
    };
  }).sort((left, right) => right.priorityScoreSum - left.priorityScoreSum);
}

async function loadOperationalAttachmentStates(
  db: ReturnType<typeof getCunoteDb>,
  sourceIds: string[],
): Promise<Map<string, OperationalAttachmentState>> {
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return new Map();
  const [archives, surfaces] = await Promise.all([
    db.select({
      source: schema.grantAttachmentArchives.source,
      sourceId: schema.grantAttachmentArchives.sourceId,
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      archiveUrl: schema.grantAttachmentArchives.archiveUrl,
      sha256: schema.grantAttachmentArchives.sha256,
    }).from(schema.grantAttachmentArchives)
      .where(inArray(schema.grantAttachmentArchives.sourceId, ids)),
    db.select({
      source: schema.grantApplicationSurfaces.source,
      sourceId: schema.grantApplicationSurfaces.sourceId,
      title: schema.grantApplicationSurfaces.title,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      status: schema.grantApplicationSurfaces.extractionStatus,
    }).from(schema.grantApplicationSurfaces)
      .where(inArray(schema.grantApplicationSurfaces.sourceId, ids)),
  ]);
  const result = new Map<string, OperationalAttachmentState>();
  for (const source of ["kstartup", "bizinfo", "bizinfo_event"] as const) for (const sourceId of ids) {
    const key = `${source}:${sourceId}`;
    const matchingArchives = archives.filter((row) => row.source === source && row.sourceId === sourceId);
    const matchingSurfaces = surfaces.filter((row) => row.source === source && row.sourceId === sourceId);
    if (matchingArchives.length === 0 && matchingSurfaces.length === 0) continue;
    const validArchives = matchingArchives.filter((row) => Boolean(row.sha256 && (row.storageKey || row.archiveUrl)));
    const linked = (surface: typeof matchingSurfaces[number]) => validArchives.some((archive) =>
      archive.storageKey === surface.sourceAttachment || archive.filename === surface.title);
    result.set(key, {
      archivedCount: matchingArchives.length,
      validArchivedCount: validArchives.length,
      surfaceCount: matchingSurfaces.length,
      pendingLinkedSurfaceCount: matchingSurfaces.filter((surface) => surface.status === "pending" && linked(surface)).length,
      pendingUnlinkedSurfaceCount: matchingSurfaces.filter((surface) => surface.status === "pending" && !linked(surface)).length,
      convertedSurfaceCount: matchingSurfaces.filter((surface) => surface.status === "preview_ready" || surface.status === "fields_ready").length,
      failedSurfaceCount: matchingSurfaces.filter((surface) => surface.status === "failed").length,
    });
  }
  return result;
}

function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

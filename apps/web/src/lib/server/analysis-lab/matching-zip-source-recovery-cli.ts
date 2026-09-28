/** Exact ZIP source recovery for one reviewed matching input gap. */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { listVerifiedArchiveMaterialEntries } from "../ingestion/archiveContainerInspection";
import { runBizInfoAttachmentArchiveBatch } from "../ingestion/bizinfoAttachmentArchiveBatch";
import { macosVisionGrantImageOcr } from "../ingestion/macosVisionOcr";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { stableJson } from "../deep-analysis/sourceRevision";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import { runGrantRevisionScopedRefresh } from "../matches/grantRevisionScopedRefreshCore";
import { prepareLabAnalysis } from "./analyze";
import { normalizeAnalysisLaunchManifest, readAnalysisLaunchArtifact } from "./launch-batch-artifacts";

const SHA = /^[a-f0-9]{64}$/u;
const CONFIRM = "RECOVER_EXACT_MATCHING_ZIP";

interface RecoveryPlan {
  schema: "matching-zip-source-recovery-plan-v2";
  preparedAt: string;
  sourceManifestSha256: string;
  mode: "source-recovery-with-match-refresh";
  grantId: string;
  source: "bizinfo";
  sourceId: string;
  applyEnd: string;
  inputSha256: string;
  attachmentManifestSha256: string;
  filename: string;
  sourceUri: string;
  originalSha256: string;
  originalBytes: number;
  maxOriginalAttachments: 1;
  expectedMaterialChildren: number;
  imageOcr: "macos_vision";
  modelCalls: 0;
  servicePromotion: false;
  grantPublication: true;
  matchStateRefresh: true;
  maxAffectedGrants: 1;
  maxExistingMatchStateRows: 1;
  matchCompanyIdsSha256: string;
  criterionCount: number;
  promotedCriterionCount: 0;
  databaseWrite: true;
  objectStorageWrite: true;
  planSha256: string;
}

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ZIP recovery plan must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseMatchingZipRecoveryPlan(value: unknown): RecoveryPlan {
  const source = record(value);
  const { planSha256, ...payload } = source;
  if (typeof planSha256 !== "string" || !SHA.test(planSha256)
    || sha(stableJson(payload)) !== planSha256) {
    throw new Error("ZIP recovery plan SHA mismatch");
  }
  if (source.schema !== "matching-zip-source-recovery-plan-v2"
    || source.mode !== "source-recovery-with-match-refresh" || source.source !== "bizinfo"
    || source.imageOcr !== "macos_vision" || source.modelCalls !== 0
    || source.servicePromotion !== false || source.databaseWrite !== true
    || source.grantPublication !== true || source.matchStateRefresh !== true
    || source.maxAffectedGrants !== 1 || source.maxExistingMatchStateRows !== 1
    || typeof source.matchCompanyIdsSha256 !== "string" || !SHA.test(source.matchCompanyIdsSha256)
    || !Number.isSafeInteger(source.criterionCount) || Number(source.criterionCount) < 0
    || source.promotedCriterionCount !== 0
    || source.objectStorageWrite !== true || source.maxOriginalAttachments !== 1
    || typeof source.sourceManifestSha256 !== "string" || !SHA.test(source.sourceManifestSha256)
    || typeof source.grantId !== "string" || !source.grantId
    || typeof source.sourceId !== "string" || !source.sourceId
    || typeof source.applyEnd !== "string" || !Number.isFinite(Date.parse(source.applyEnd))
    || typeof source.inputSha256 !== "string" || !SHA.test(source.inputSha256)
    || typeof source.attachmentManifestSha256 !== "string" || !SHA.test(source.attachmentManifestSha256)
    || typeof source.filename !== "string" || !source.filename.toLowerCase().endsWith(".zip")
    || typeof source.sourceUri !== "string" || !/^https:\/\//u.test(source.sourceUri)
    || typeof source.originalSha256 !== "string" || !SHA.test(source.originalSha256)
    || !Number.isSafeInteger(source.originalBytes) || Number(source.originalBytes) < 1
    || !Number.isSafeInteger(source.expectedMaterialChildren)
    || Number(source.expectedMaterialChildren) < 1
    || Number(source.expectedMaterialChildren) > 10) {
    throw new Error("ZIP recovery plan contract mismatch");
  }
  return value as RecoveryPlan;
}

async function verifyCurrentPlan(plan: RecoveryPlan) {
  const sourceManifest = normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", plan.sourceManifestSha256),
  );
  const sourceTarget = sourceManifest.targets.find((target) => target.grantId === plan.grantId);
  if (sourceManifest.execution.analysisMode !== "matching_only"
    || sourceTarget?.inputSha256 !== plan.inputSha256
    || sourceTarget.attachmentManifestSha256 !== plan.attachmentManifestSha256) {
    throw new Error("ZIP recovery source manifest binding mismatch");
  }
  const db = getCunoteDb();
  const [grant] = await db.select({
    id: schema.grants.id, source: schema.grants.source,
    sourceId: schema.grants.sourceId, status: schema.grants.status,
    applyEnd: schema.grants.applyEnd,
  }).from(schema.grants).where(eq(schema.grants.id, plan.grantId));
  if (!grant || grant.source !== plan.source || grant.sourceId !== plan.sourceId
    || grant.status !== "open" || grant.applyEnd?.toISOString() !== plan.applyEnd
    || grant.applyEnd.getTime() < Date.now()) {
    throw new Error("ZIP recovery grant drift");
  }
  const links = await db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));
  const component = expandConfirmedGrantComponentIds([plan.grantId], links);
  const matches = await db.select({companyId: schema.matchState.companyId})
    .from(schema.matchState).where(eq(schema.matchState.grantId, plan.grantId));
  const criteria = await db.select({stableKey: schema.grantCriteria.stableKey})
    .from(schema.grantCriteria).where(eq(schema.grantCriteria.grantId, plan.grantId));
  if (component.length !== 1 || component[0] !== plan.grantId
    || matches.length !== plan.maxExistingMatchStateRows
    || sha(stableJson(matches.map((item) => item.companyId).sort())) !== plan.matchCompanyIdsSha256
    || criteria.length !== plan.criterionCount
    || criteria.some((item) => item.stableKey !== null)) {
    throw new Error("ZIP recovery match publication scope drift");
  }
  const refreshDryRun = await runGrantRevisionScopedRefresh({
    db, grantIds: [plan.grantId], companyIds: matches.map((item) => item.companyId),
    companyLimit: plan.maxExistingMatchStateRows, asOf: new Date(), write: false,
  });
  if (refreshDryRun.candidateComplete !== true
    || refreshDryRun.candidateCompanyCount !== plan.maxExistingMatchStateRows
    || refreshDryRun.plannedStateCount !== plan.maxExistingMatchStateRows
    || !Array.isArray(refreshDryRun.effectiveGrantIds)
    || stableJson(refreshDryRun.effectiveGrantIds) !== stableJson([plan.grantId])) {
    throw new Error("ZIP recovery match refresh dry-run scope mismatch");
  }
  const prepared = await prepareLabAnalysis(plan.grantId);
  const gap = prepared.input.attachmentPreparationReport?.find((item) => item.filename === plan.filename);
  if (prepared.input.inputSha256 !== plan.inputSha256
    || prepared.input.attachmentManifestSha256 !== plan.attachmentManifestSha256
    || gap?.missingReason !== "markdown_missing") {
    throw new Error("ZIP recovery input drift");
  }
  const [archive] = await db.select({
    filename: schema.grantAttachmentArchives.filename,
    sourceUri: schema.grantAttachmentArchives.sourceUri,
    sha256: schema.grantAttachmentArchives.sha256,
    bytes: schema.grantAttachmentArchives.bytes,
  }).from(schema.grantAttachmentArchives).where(and(
    eq(schema.grantAttachmentArchives.source, plan.source),
    eq(schema.grantAttachmentArchives.sourceId, plan.sourceId),
    eq(schema.grantAttachmentArchives.filename, plan.filename),
  ));
  if (!archive || archive.sourceUri !== plan.sourceUri
    || archive.sha256 !== plan.originalSha256 || archive.bytes !== plan.originalBytes) {
    throw new Error("ZIP recovery stored source drift");
  }
  const options = {
    db, storage: null, scanLimit: 1, asOf: new Date(), write: false,
    convertHwp: true, maxGrants: 1, maxTotalAttachments: 1, maxAttachmentsPerGrant: 1,
    sourceIds: [plan.sourceId], reprocessMissingMarkdown: true,
    imageOcr: macosVisionGrantImageOcr, imageOcrName: plan.imageOcr,
    expectedExactAttachment: { sourceId: plan.sourceId, filename: plan.filename,
      sha256: plan.originalSha256, sourceUri: plan.sourceUri },
  } as const;
  const selection = await runBizInfoAttachmentArchiveBatch(options);
  if (selection.batchCandidateCount !== 1 || selection.selectedAttachmentCount !== 1) {
    throw new Error("ZIP recovery dry-run selection drift");
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("ZIP recovery R2 storage is unavailable");
  const response = await fetch(plan.sourceUri, {
    headers: { accept: "*/*" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ZIP recovery official source HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== plan.originalBytes || sha(bytes) !== plan.originalSha256) {
    throw new Error("ZIP recovery official source bytes drift");
  }
  const material = listVerifiedArchiveMaterialEntries(plan.filename, bytes);
  if (material.length !== plan.expectedMaterialChildren
    || !material.some((item) => /\.png$/iu.test(item.filename))) {
    throw new Error("ZIP recovery child inventory drift");
  }
  return { db, storage, materialCount: material.length };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const planPath = args.find((arg) => arg.startsWith("--plan="))?.slice(7);
  const receiptPath = args.find((arg) => arg.startsWith("--receipt="))?.slice(10);
  const confirm = args.find((arg) => arg.startsWith("--confirm="))?.slice(10);
  const write = args.includes("--write");
  if (!planPath || args.length !== (write ? 4 : 1)
    || write && (!receiptPath || confirm !== CONFIRM)) {
    throw new Error(`usage: --plan=<path> [--write --receipt=<path> --confirm=${CONFIRM}]`);
  }
  loadAnalysisLabEnv();
  try {
    const plan = parseMatchingZipRecoveryPlan(JSON.parse(await readFile(planPath, "utf8")));
    const { db, storage, materialCount } = await verifyCurrentPlan(plan);
    if (!write) {
      console.log(JSON.stringify({ status: "READY_FOR_SOURCE_RECOVERY_APPROVAL",
        planSha256: plan.planSha256, sourceId: plan.sourceId, exactOriginalCount: 1,
        materialChildren: materialCount, maxAffectedGrants: plan.maxAffectedGrants,
        maxExistingMatchStateRows: plan.maxExistingMatchStateRows,
        grantPublication: true, matchStateRefresh: true, modelCalls: 0,
        databaseWrite: false, objectStorageWrite: false }));
      return;
    }
    await mkdir(dirname(receiptPath!), { recursive: true });
    const lockPath = `${receiptPath}.lock`;
    const lock = await open(lockPath, "wx");
    let mutationStarted = false;
    let receiptWritten = false;
    try {
      try { await readFile(receiptPath!, "utf8"); throw new Error("ZIP recovery receipt already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await lock.writeFile(`${JSON.stringify({ planSha256: plan.planSha256, startedAt: new Date().toISOString() })}\n`);
      mutationStarted = true;
      const batch = await runBizInfoAttachmentArchiveBatch({
        db, storage, scanLimit: 1, asOf: new Date(), write: true,
        convertHwp: true, maxGrants: 1, maxTotalAttachments: 1, maxAttachmentsPerGrant: 1,
        sourceIds: [plan.sourceId], reprocessMissingMarkdown: true,
        imageOcr: macosVisionGrantImageOcr, imageOcrName: plan.imageOcr,
        expectedExactAttachment: { sourceId: plan.sourceId, filename: plan.filename,
          sha256: plan.originalSha256, sourceUri: plan.sourceUri },
      });
      const result = batch.results[0];
      const prepared = await prepareLabAnalysis(plan.grantId);
      const parent = prepared.input.attachmentPreparationReport?.find((item) => item.filename === plan.filename);
      const payload = { schema: "matching-zip-source-recovery-receipt-v1",
        planSha256: plan.planSha256, finishedAt: new Date().toISOString(),
        succeededCount: batch.succeededCount, failedCount: batch.failedCount,
        archivedCount: result?.archivedCount ?? null,
        convertedCount: result?.convertedCount ?? null,
        conversionFailureCount: result?.failureCount ?? null,
        revisionCounts: result?.revisionCounts ?? null,
        matchStateInvalidatedCount: result?.matchStateInvalidatedCount ?? null,
        matchStateRefreshedCount: result?.matchStateRefreshedCount ?? null,
        matchStateRefreshRequired: result?.matchStateRefreshRequired ?? null,
        matchStateRefreshGrantIds: result?.matchStateRefreshGrantIds ?? null,
        promotionProtectedCount: result?.promotionProtectedCount ?? null,
        parentOutcome: parent?.inputOutcome ?? null,
        inputSha256: prepared.input.inputSha256,
        attachmentManifestSha256: prepared.input.attachmentManifestSha256,
        modelCalls: 0, servicePromotion: false,
        databaseWrite: true, objectStorageWrite: true };
      const receipt = { ...payload, receiptSha256: sha(stableJson(payload)) };
      await writeFile(receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      const written = record(JSON.parse(await readFile(receiptPath!, "utf8")));
      const { receiptSha256: writtenSha, ...writtenPayload } = written;
      if (writtenSha !== receipt.receiptSha256 || sha(stableJson(writtenPayload)) !== writtenSha) {
        throw new Error("ZIP recovery receipt readback SHA mismatch");
      }
      receiptWritten = true;
      const passed = batch.succeededCount === 1 && batch.failedCount === 0
        && result?.archivedCount === plan.expectedMaterialChildren + 1
        && result.convertedCount === plan.expectedMaterialChildren
        && result.failureCount === 0
        && (result.revisionCounts as Record<string, number> | undefined)?.changed === 1
        && result.matchStateInvalidatedCount === plan.maxExistingMatchStateRows
        && result.matchStateRefreshRequired === false
        && Array.isArray(result.matchStateRefreshGrantIds)
        && stableJson(result.matchStateRefreshGrantIds) === stableJson([plan.grantId])
        && result.promotionProtectedCount === 0
        && parent?.inputOutcome === "covered_by_children";
      console.log(JSON.stringify({ status: passed ? "COMPLETE" : "PARTIAL",
        planSha256: plan.planSha256, receiptSha256: receipt.receiptSha256,
        archivedCount: payload.archivedCount, convertedCount: payload.convertedCount,
        parentOutcome: payload.parentOutcome }));
      if (!passed) process.exitCode = 2;
    } finally {
      await lock.close();
      if (!mutationStarted || receiptWritten) await unlink(lockPath);
    }
  } finally { await closeCunoteDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

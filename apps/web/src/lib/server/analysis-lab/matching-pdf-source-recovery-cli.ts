/** Exact, source-only PDF text recovery for a reviewed matching repair plan. */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { inArray } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { macosVisionGrantImageOcr } from "../ingestion/macosVisionOcr";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import {
  listPdfTextOcrRecoveryCandidates,
  recoverPdfTextOcrCandidates,
  type PdfTextOcrRecoveryCandidate,
} from "../deep-analysis/pdfTextOcrRecovery";
import { stableJson } from "../deep-analysis/sourceRevision";
import { prepareLabAnalysis } from "./analyze";
import { normalizeAnalysisLaunchManifest, readAnalysisLaunchArtifact } from "./launch-batch-artifacts";
import { classifyNoticePeriod } from "./notice-period";

const SHA = /^[a-f0-9]{64}$/u;
const CONFIRM = "RECOVER_EXACT_MATCHING_PDFS";

interface RecoveryTarget {
  grantId: string;
  source: "bizinfo" | "kstartup";
  sourceId: string;
  applyEnd: string;
  inputSha256: string;
  attachmentManifestSha256: string;
  missingPdfFiles: string[];
}

interface RecoveryPdf {
  grantId: string;
  sourceId: string;
  surfaceId: string;
  sourceAttachment: string;
  pdfStorageKey: string;
  pdfSha256: string;
  title: string;
}

interface RecoveryPlan {
  schema: "matching-pdf-source-recovery-plan-v1" | "matching-pdf-source-recovery-plan-v2";
  preparedAt: string;
  /** v1 binds a prepared launch; v2 repairs current inventory before launch preparation. */
  sourceManifestSha256?: string;
  sourceKind?: "current_inventory";
  mode: "source-recovery-only";
  modelCalls: 0;
  servicePromotion: false;
  objectStorageWrite: true;
  databaseWrite: true;
  targetCount: number;
  pdfCount: number;
  targets: RecoveryTarget[];
  pdfs: RecoveryPdf[];
  planSha256: string;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PDF recovery plan must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseMatchingPdfRecoveryPlan(value: unknown): RecoveryPlan {
  const source = record(value);
  const { planSha256, ...payload } = source;
  if (typeof planSha256 !== "string" || !SHA.test(planSha256)
    || sha(stableJson(payload)) !== planSha256) {
    throw new Error("PDF recovery plan SHA mismatch");
  }
  if (!["matching-pdf-source-recovery-plan-v1", "matching-pdf-source-recovery-plan-v2"].includes(String(source.schema))
    || source.mode !== "source-recovery-only"
    || source.modelCalls !== 0 || source.servicePromotion !== false
    || source.objectStorageWrite !== true || source.databaseWrite !== true
    || !Array.isArray(source.targets) || !Array.isArray(source.pdfs)
    || !Number.isInteger(source.targetCount) || !Number.isInteger(source.pdfCount)
    || source.targetCount !== source.targets.length
    || source.pdfCount !== source.pdfs.length
    || source.targetCount < 1 || source.pdfCount < 1
    || (source.schema === "matching-pdf-source-recovery-plan-v2"
      && (source.targetCount > 10 || source.pdfCount > 20))
    || (source.schema === "matching-pdf-source-recovery-plan-v1"
      ? typeof source.sourceManifestSha256 !== "string"
        || !SHA.test(source.sourceManifestSha256)
        || "sourceKind" in source
      : source.sourceKind !== "current_inventory" || "sourceManifestSha256" in source)) {
    throw new Error("PDF recovery plan contract mismatch");
  }
  const targets = source.targets.map((value) => record(value));
  const pdfs = source.pdfs.map((value) => record(value));
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length
    || new Set(pdfs.map((pdf) => pdf.surfaceId)).size !== pdfs.length
    || targets.some((target) => typeof target.grantId !== "string"
      || !["bizinfo", "kstartup"].includes(String(target.source))
      || typeof target.sourceId !== "string" || !target.sourceId
      || typeof target.applyEnd !== "string" || !Number.isFinite(Date.parse(target.applyEnd))
      || typeof target.inputSha256 !== "string" || !SHA.test(target.inputSha256)
      || typeof target.attachmentManifestSha256 !== "string" || !SHA.test(target.attachmentManifestSha256)
      || !Array.isArray(target.missingPdfFiles) || target.missingPdfFiles.length < 1
      || target.missingPdfFiles.some((name: unknown) => typeof name !== "string" || !name))
    || pdfs.some((pdf) => typeof pdf.grantId !== "string"
      || typeof pdf.sourceId !== "string" || typeof pdf.surfaceId !== "string"
      || typeof pdf.sourceAttachment !== "string" || !pdf.sourceAttachment
      || typeof pdf.pdfStorageKey !== "string" || !pdf.pdfStorageKey
      || typeof pdf.pdfSha256 !== "string" || !SHA.test(pdf.pdfSha256)
      || typeof pdf.title !== "string" || !pdf.title
      || !targets.some((target) => target.grantId === pdf.grantId
        && target.sourceId === pdf.sourceId))) {
    throw new Error("PDF recovery plan target binding mismatch");
  }
  for (const target of targets) {
    const titles = pdfs.filter((pdf) => pdf.grantId === target.grantId)
      .map((pdf) => pdf.title).sort();
    if (stableJson(titles) !== stableJson([...target.missingPdfFiles as string[]].sort())) {
      throw new Error(`PDF recovery target files mismatch: ${target.sourceId}`);
    }
  }
  return value as RecoveryPlan;
}

function candidateRecord(candidate: PdfTextOcrRecoveryCandidate): RecoveryPdf {
  return {
    grantId: candidate.target.grantId,
    sourceId: candidate.target.sourceId,
    surfaceId: candidate.surfaceId,
    sourceAttachment: candidate.sourceAttachment,
    pdfStorageKey: candidate.pdfStorageKey,
    pdfSha256: candidate.pdfSha256,
    title: candidate.title,
  };
}

async function verifyCurrentPlan(plan: RecoveryPlan) {
  if (plan.schema === "matching-pdf-source-recovery-plan-v1") {
    const sourceManifest = normalizeAnalysisLaunchManifest(
      await readAnalysisLaunchArtifact("manifests", plan.sourceManifestSha256!),
    );
    if (sourceManifest.execution.analysisMode !== "matching_only") {
      throw new Error("PDF recovery source manifest mode mismatch");
    }
    for (const target of plan.targets) {
      const original = sourceManifest.targets.find((item) => item.grantId === target.grantId);
      if (!original || original.inputSha256 !== target.inputSha256
        || original.attachmentManifestSha256 !== target.attachmentManifestSha256) {
        throw new Error(`PDF recovery source manifest binding mismatch: ${target.sourceId}`);
      }
    }
  }
  const db = getCunoteDb();
  const grants = await db.select({
    id: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    status: schema.grants.status,
    servingState: schema.grants.servingState,
    applyStart: schema.grants.applyStart,
    applyEnd: schema.grants.applyEnd,
  }).from(schema.grants).where(inArray(schema.grants.id, plan.targets.map((target) => target.grantId)));
  for (const target of plan.targets) {
    const grant = grants.find((item) => item.id === target.grantId);
    if (!grant || grant.source !== target.source || grant.sourceId !== target.sourceId
      || grant.status !== "open" || grant.servingState !== "visible"
      || grant.applyEnd?.toISOString() !== target.applyEnd
      || classifyNoticePeriod(grant.applyStart, grant.applyEnd) !== "eligible") {
      throw new Error(`PDF recovery grant drift: ${target.sourceId}`);
    }
    const prepared = await prepareLabAnalysis(target.grantId);
    const missing = prepared.input.attachmentPreparationReport?.filter((item) =>
      item.inputOutcome === "unavailable" && item.recovery.mode === "pdf_text_or_ocr")
      .map((item) => item.filename).sort() ?? [];
    if (prepared.input.inputSha256 !== target.inputSha256
      || prepared.input.attachmentManifestSha256 !== target.attachmentManifestSha256
      || stableJson(missing) !== stableJson([...target.missingPdfFiles].sort())) {
      throw new Error(`PDF recovery input drift: ${target.sourceId}`);
    }
  }
  const candidates = await listPdfTextOcrRecoveryCandidates({
    db,
    targets: plan.targets.map((target) => ({
      grantId: target.grantId,
      source: target.source,
      sourceId: target.sourceId,
      opaqueCommitmentSha256: target.inputSha256,
    })),
  });
  const sort = (items: RecoveryPdf[]) => items.sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) || a.sourceAttachment.localeCompare(b.sourceAttachment));
  if (stableJson(sort(candidates.map(candidateRecord))) !== stableJson(sort([...plan.pdfs]))) {
    throw new Error("PDF recovery candidate drift");
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("PDF recovery R2 storage is unavailable");
  for (const candidate of candidates) {
    const source = await storage.getObjectBytes(candidate.pdfStorageKey);
    if (createHash("sha256").update(source.body).digest("hex") !== candidate.pdfSha256) {
      throw new Error(`PDF recovery source bytes drift: ${candidate.target.sourceId}`);
    }
  }
  return { candidates, storage };
}

async function prepareCurrentInventoryPlan(grantIds: string[], outputPath: string) {
  const db = getCunoteDb();
  const grants = await db.select({
    id: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    status: schema.grants.status,
    servingState: schema.grants.servingState,
    applyStart: schema.grants.applyStart,
    applyEnd: schema.grants.applyEnd,
  }).from(schema.grants).where(inArray(schema.grants.id, grantIds));
  const targets: RecoveryTarget[] = [];
  for (const grantId of grantIds) {
    const grant = grants.find((item) => item.id === grantId);
    if (!grant || (grant.source !== "bizinfo" && grant.source !== "kstartup")
      || grant.status !== "open" || grant.servingState !== "visible"
      || !grant.applyEnd || classifyNoticePeriod(grant.applyStart, grant.applyEnd) !== "eligible") {
      throw new Error(`PDF recovery grant is not currently eligible: ${grantId}`);
    }
    const prepared = await prepareLabAnalysis(grantId);
    const missingPdfFiles = prepared.input.attachmentPreparationReport?.filter((item) =>
      item.inputOutcome === "unavailable" && item.recovery.mode === "pdf_text_or_ocr")
      .map((item) => item.filename).sort() ?? [];
    if (missingPdfFiles.length === 0) throw new Error(`No missing PDF text: ${grant.sourceId}`);
    targets.push({ grantId, source: grant.source, sourceId: grant.sourceId,
      applyEnd: grant.applyEnd.toISOString(), inputSha256: prepared.input.inputSha256,
      attachmentManifestSha256: prepared.input.attachmentManifestSha256, missingPdfFiles });
  }
  const candidates = await listPdfTextOcrRecoveryCandidates({ db,
    targets: targets.map((target) => ({ grantId: target.grantId, source: target.source,
      sourceId: target.sourceId, opaqueCommitmentSha256: target.inputSha256 })) });
  if (candidates.length < 1 || candidates.length > 20) {
    throw new Error("PDF recovery candidate count is outside the bounded scope");
  }
  const pdfs = candidates.map(candidateRecord).sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) || a.sourceAttachment.localeCompare(b.sourceAttachment));
  for (const target of targets) {
    const titles = pdfs.filter((pdf) => pdf.grantId === target.grantId)
      .map((pdf) => pdf.title).sort();
    if (stableJson(titles) !== stableJson(target.missingPdfFiles)) {
      throw new Error(`PDF recovery candidate set is incomplete: ${target.sourceId}`);
    }
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("PDF recovery R2 storage is unavailable");
  for (const candidate of candidates) {
    const source = await storage.getObjectBytes(candidate.pdfStorageKey);
    if (sha(source.body) !== candidate.pdfSha256) {
      throw new Error(`PDF recovery source bytes drift: ${candidate.target.sourceId}`);
    }
  }
  const payload = { schema: "matching-pdf-source-recovery-plan-v2" as const,
    preparedAt: new Date().toISOString(), sourceKind: "current_inventory" as const,
    mode: "source-recovery-only" as const, modelCalls: 0 as const,
    servicePromotion: false as const, objectStorageWrite: true as const,
    databaseWrite: true as const, targetCount: targets.length,
    pdfCount: pdfs.length, targets, pdfs };
  const plan = parseMatchingPdfRecoveryPlan({ ...payload, planSha256: sha(stableJson(payload)) });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  const readback = parseMatchingPdfRecoveryPlan(JSON.parse(await readFile(outputPath, "utf8")));
  if (stableJson(readback) !== stableJson(plan)) throw new Error("PDF recovery plan readback mismatch");
  console.log(JSON.stringify({ status: "PREPARED_SOURCE_RECOVERY_PLAN", path: outputPath,
    planSha256: plan.planSha256, targetCount: plan.targetCount, pdfCount: plan.pdfCount,
    sourceBytesVerified: candidates.length, modelCalls: 0, databaseWrite: false,
    objectStorageWrite: false }));
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--prepare")) {
    const ids = args.find((arg) => arg.startsWith("--grant-ids="))?.slice(12).split(",") ?? [];
    const output = args.find((arg) => arg.startsWith("--output="))?.slice(9);
    if (args.length !== 3 || !output || ids.length < 1 || ids.length > 10
      || new Set(ids).size !== ids.length
      || ids.some((id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))) {
      throw new Error("usage: --prepare --grant-ids=<uuid,...> --output=<path>");
    }
    loadAnalysisLabEnv();
    try { await prepareCurrentInventoryPlan(ids, output); }
    finally { await closeCunoteDb(); }
    return;
  }
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
    const plan = parseMatchingPdfRecoveryPlan(JSON.parse(await readFile(planPath, "utf8")));
    const { candidates, storage } = await verifyCurrentPlan(plan);
    if (!write) {
      console.log(JSON.stringify({ status: "READY_FOR_SOURCE_RECOVERY_APPROVAL",
        planSha256: plan.planSha256, targetCount: plan.targetCount,
        pdfCount: candidates.length, sourceBytesVerified: candidates.length,
        modelCalls: 0, databaseWrite: false, objectStorageWrite: false }));
      return;
    }
    await mkdir(dirname(receiptPath!), { recursive: true });
    const lockPath = `${receiptPath}.lock`;
    const lock = await open(lockPath, "wx");
    let mutationStarted = false;
    let receiptWritten = false;
    try {
      try { await readFile(receiptPath!, "utf8"); throw new Error("PDF recovery receipt already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await lock.writeFile(`${JSON.stringify({ planSha256: plan.planSha256, startedAt: new Date().toISOString() })}\n`);
      mutationStarted = true;
      const result = await recoverPdfTextOcrCandidates({
        db: getCunoteDb(), storage, candidates, imageOcr: macosVisionGrantImageOcr,
      });
      const remaining = [];
      for (const target of plan.targets) {
        const prepared = await prepareLabAnalysis(target.grantId);
        const missing = prepared.input.attachmentPreparationReport?.filter((item) =>
          item.inputOutcome === "unavailable" && item.recovery.mode === "pdf_text_or_ocr") ?? [];
        remaining.push({ sourceId: target.sourceId, missingPdfCount: missing.length,
          inputSha256: prepared.input.inputSha256,
          attachmentManifestSha256: prepared.input.attachmentManifestSha256 });
      }
      const payload = {schema: "matching-pdf-source-recovery-receipt-v1", planSha256: plan.planSha256,
        finishedAt: new Date().toISOString(), result, remaining, modelCalls: 0,
        servicePromotion: false, databaseWrite: true, objectStorageWrite: true};
      const receipt = { ...payload, receiptSha256: sha(stableJson(payload)) };
      await writeFile(receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      const written = record(JSON.parse(await readFile(receiptPath!, "utf8")));
      const { receiptSha256: writtenSha, ...writtenPayload } = written;
      if (writtenSha !== receipt.receiptSha256 || sha(stableJson(writtenPayload)) !== writtenSha) {
        throw new Error("PDF recovery receipt readback SHA mismatch");
      }
      receiptWritten = true;
      const passed = result.candidateCount === plan.pdfCount
        && result.succeededCount === plan.pdfCount && result.failedCount === 0
        && remaining.every((item) => item.missingPdfCount === 0);
      console.log(JSON.stringify({ status: passed ? "COMPLETE" : "PARTIAL", planSha256: plan.planSha256,
        receiptSha256: receipt.receiptSha256, succeeded: result.succeededCount,
        failed: result.failedCount, remainingPdfTargets: remaining.filter((item) => item.missingPdfCount > 0).length }));
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

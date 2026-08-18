import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { VERSION } from "kordoc";
import { APPLICATION_ROUNDTRIP_ADOPTED_MODEL } from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { writeImmutableBytesAtomic } from "../immutable-artifact-fs";
import { validateDeepRepairLiveReceipt } from "../deep-repair-live-receipt";
import { readCurrentDeepRepairExecutionProvenance } from "../deep-repair-runtime-provenance";
import { findMonorepoRoot } from "../run-store";
import { analyzeRoundtripDocument } from "./analyze-document";
import {
  createApplicationRoundtripCandidatePreflight,
  type ApplicationRoundtripCandidate,
} from "./candidate-preflight";
import { isSubscriptionRoundtripLlmCandidate } from "./field-planner";

const repositoryRoot = findMonorepoRoot();
const analysisLabRoot = join(repositoryRoot, "spike-out", "analysis-lab");
const experimentRoot = join(analysisLabRoot, "experiments");
const proposalRoot = join(analysisLabRoot, "application-roundtrip", "proposals");
const SHA256 = /^[a-f0-9]{64}$/u;

const preflight = createApplicationRoundtripCandidatePreflight({
  now: () => new Date(),
  readExecutionProvenance: readCurrentDeepRepairExecutionProvenance,
  loadCandidates: loadPublishableCandidateChain,
  async listAttachments(candidate) {
    return getCunoteDb()
      .select({
        filename: schema.grantAttachmentArchives.filename,
        storageKey: schema.grantAttachmentArchives.storageKey,
        sha256: schema.grantAttachmentArchives.sha256,
        bytes: schema.grantAttachmentArchives.bytes,
      })
      .from(schema.grantAttachmentArchives)
      .where(and(
        eq(schema.grantAttachmentArchives.source, candidate.source),
        eq(schema.grantAttachmentArchives.sourceId, candidate.sourceId),
      ));
  },
  async readAttachment(storageKey) {
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 환경 설정이 없어 Kordoc 원문을 probe할 수 없습니다.");
    return (await storage.getObjectBytes(storageKey)).body;
  },
  async probeAttachment({ filename, declaredFormat, sourceSha256, body }) {
    const { document } = await analyzeRoundtripDocument({
      attachmentId: sourceSha256.slice(0, 20),
      filename,
      declaredFormat,
      sourceSha256,
      body,
      apiKey: null,
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      transport: "api",
    });
    if (document.detectedFormat !== "hwp" && document.detectedFormat !== "hwpx") {
      throw new Error("Kordoc actual format probe가 HWP/HWPX를 반환하지 않았습니다.");
    }
    const llmCandidateCount = document.fields.filter(isSubscriptionRoundtripLlmCandidate).length;
    return {
      detectedFormat: document.detectedFormat,
      role: document.role,
      roleConfidence: document.roleConfidence,
      fieldCandidateCount: document.fields.length,
      llmCandidateCount,
      deterministicDecisionCount: document.fields.length - llmCandidateCount,
    };
  },
  async writeProposal({ sha256, bytes }) {
    await mkdir(proposalRoot, { recursive: true });
    await writeImmutableBytesAtomic(join(proposalRoot, `${sha256}.json`), bytes);
  },
});

/** deep terminal chain의 publishable 후보를 실제 원문 probe해 별도 Kordoc proposal로 봉인한다. */
export async function prepareCurrentApplicationRoundtripCandidates(input: {
  finalReceiptSha256: string;
}) {
  const result = await preflight.prepare(input);
  return {
    ...result,
    engine: "kordoc" as const,
    engineVersion: VERSION,
    proposalPath: relative(
      repositoryRoot,
      join(proposalRoot, `${result.proposal.proposalSha256}.json`),
    ).split(sep).join("/"),
  };
}

async function loadPublishableCandidateChain(finalReceiptSha256: string): Promise<{
  planSha256: string;
  observationsSha256: string;
  observedCount: number;
  candidates: ApplicationRoundtripCandidate[];
}> {
  if (!SHA256.test(finalReceiptSha256)) throw new Error("terminal receipt SHA-256 형식이 잘못됐습니다.");
  const reversed = [];
  let cursor: string | null = finalReceiptSha256;
  while (cursor) {
    const value = JSON.parse(await readFile(join(experimentRoot, "receipts", `${cursor}.json`), "utf8"));
    const receipt = validateDeepRepairLiveReceipt(value);
    if (receipt.receiptSha256 !== cursor) throw new Error("terminal receipt 경로와 self hash가 다릅니다.");
    reversed.push(receipt);
    cursor = receipt.parentReceiptSha256;
  }
  const receipts = reversed.reverse();
  const terminal = receipts.at(-1);
  if (!terminal || terminal.observationsSha256 === null || terminal.observedCount !== receipts.length) {
    throw new Error("terminal receipt chain과 observations binding이 완결되지 않았습니다.");
  }
  receipts.forEach((receipt, index) => {
    if (
      receipt.planSha256 !== terminal.planSha256
      || receipt.target.sequence !== index
      || receipt.observedCount !== index + 1
      || receipt.parentReceiptSha256 !== (index === 0 ? null : receipts[index - 1]!.receiptSha256)
    ) {
      throw new Error("terminal receipt chain의 plan/sequence/parent가 일치하지 않습니다.");
    }
  });

  const candidates: ApplicationRoundtripCandidate[] = [];
  for (const receipt of receipts) {
    if (receipt.noticeOutcome !== "publishable") continue;
    if (!receipt.runArtifactPath || !receipt.runArtifactSha256) {
      throw new Error("publishable receipt에 exact run artifact가 없습니다.");
    }
    const bytes = await readLabRunArtifact(receipt.runArtifactPath);
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.runArtifactSha256) {
      throw new Error("deep run artifact SHA-256이 receipt와 다릅니다.");
    }
    const run = parseCandidateRun(JSON.parse(bytes.toString("utf8")), receipt.target.grantId);
    candidates.push({
      sequence: receipt.target.sequence,
      grantId: receipt.target.grantId,
      source: run.source,
      sourceId: run.sourceId,
      title: run.title,
      matchingReadiness: run.matchingReadiness,
      deepReceiptSha256: receipt.receiptSha256,
      deepRunArtifactSha256: receipt.runArtifactSha256,
    });
  }
  return {
    planSha256: terminal.planSha256,
    observationsSha256: terminal.observationsSha256,
    observedCount: terminal.observedCount,
    candidates,
  };
}

async function readLabRunArtifact(logicalPath: string): Promise<Buffer> {
  if (!logicalPath.startsWith("spike-out/analysis-lab/") || logicalPath.includes("\\")) {
    throw new Error("deep run artifact 경로가 허용 범위 밖입니다.");
  }
  const segments = logicalPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || segments[2] === "experiments") {
    throw new Error("deep run artifact 경로가 허용 범위 밖입니다.");
  }
  const candidate = resolve(repositoryRoot, logicalPath);
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(analysisLabRoot),
    realpath(candidate),
  ]);
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("deep run artifact가 analysis-lab 밖을 가리킵니다.");
  }
  return readFile(canonicalCandidate);
}

function parseCandidateRun(value: unknown, expectedGrantId: string): {
  source: "kstartup" | "bizinfo" | "bizinfo_event";
  sourceId: string;
  title: string;
  matchingReadiness: "ready" | "conditional";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deep run artifact가 객체가 아닙니다.");
  const run = value as Record<string, unknown>;
  const matchingReadiness = run.matchingReadiness;
  const source = run.source;
  if (
    run.grantId !== expectedGrantId
    || (source !== "kstartup" && source !== "bizinfo" && source !== "bizinfo_event")
    || typeof run.sourceId !== "string"
    || typeof run.title !== "string"
    || (matchingReadiness !== "ready" && matchingReadiness !== "conditional")
  ) {
    throw new Error("publishable deep run의 candidate binding이 유효하지 않습니다.");
  }
  return {
    source,
    sourceId: run.sourceId,
    title: run.title,
    matchingReadiness,
  };
}

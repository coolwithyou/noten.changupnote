import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisQualityDownstreamEvidence } from "@/features/dev/analysis-lab/quality-contract";
import { analysisLabDir } from "./run-store";

export const PRODUCT_CANARY_EVIDENCE_SCHEMA = "analysis-lab-product-canary-v1" as const;

export interface ProductCanaryEvidence {
  schema: typeof PRODUCT_CANARY_EVIDENCE_SCHEMA;
  canaryId: string;
  grantId: string;
  runId: string;
  releaseId: string;
  manifestSha256: string;
  evaluatedAt: string;
  deepPromotion: AnalysisQualityDownstreamEvidence;
  matchingCanary: AnalysisQualityDownstreamEvidence;
  fieldMaterialization: AnalysisQualityDownstreamEvidence;
  workspaceCanary: AnalysisQualityDownstreamEvidence;
}

export interface ProductCanaryObservation {
  promotionVerified: boolean;
  matchingVerified: boolean;
  matchingCompanyCount: number;
  applicationEvidencePresent: boolean;
  connectedFieldCount: number;
  seededAnswerCount: number;
  precomputeStatus: string | null;
  workspaceMode: string;
  workspaceLadder: string;
  activeDocumentKey: string | null;
  draftId: string | null;
  pollConversion: boolean;
  recoveryNeeded: boolean;
}

/**
 * 승격 성공을 제품 성공으로 오인하지 않도록 실제 사용자 경로의 네 경계를 각각 판정한다.
 * 제품 레인은 부분 성공을 허용하지 않으며, 실패한 노드가 다음 개선 루프의 정확한 시작점이 된다.
 */
export function evaluateProductCanaryObservation(
  input: ProductCanaryObservation,
): Pick<
  ProductCanaryEvidence,
  "deepPromotion" | "matchingCanary" | "fieldMaterialization" | "workspaceCanary"
> {
  const deepPromotion = node(
    input.promotionVerified,
    input.promotionVerified
      ? "승격 DB 상태와 release 원장이 일치합니다."
      : "승격 DB 상태 또는 release 원장이 검증되지 않았습니다.",
    ["verification.canary.json"],
  );
  const matchingCanary = node(
    input.matchingVerified && input.matchingCompanyCount > 0,
    input.matchingVerified && input.matchingCompanyCount > 0
      ? `회사 ${input.matchingCompanyCount}개 매칭 섀도가 회귀 없이 통과했습니다.`
      : "대상 공고의 매칭 섀도 증거가 없거나 실패했습니다.",
    [`회사 ${input.matchingCompanyCount}개`, "shadow.json"],
  );
  const materialized = input.applicationEvidencePresent
    && input.precomputeStatus === "complete"
    && input.connectedFieldCount > 0;
  const fieldMaterialization = node(
    materialized,
    materialized
      ? `Kordoc 완료 결과가 빠른 작성 필드 ${input.connectedFieldCount}개로 반영됐습니다.`
      : "Kordoc 완료 증거와 실제 빠른 작성 필드가 함께 확인되지 않았습니다.",
    [
      `precompute ${input.precomputeStatus ?? "없음"}`,
      `연결 필드 ${input.connectedFieldCount}개`,
      `프로필 자동 채움 ${input.seededAnswerCount}개`,
    ],
  );
  const workspaceReady = input.workspaceMode === "admin_preview"
    && input.workspaceLadder === "a"
    && Boolean(input.activeDocumentKey)
    && input.connectedFieldCount > 0
    && input.draftId === null
    && !input.pollConversion
    && !input.recoveryNeeded;
  const workspaceCanary = node(
    workspaceReady,
    workspaceReady
      ? "관리자 읽기 전용 시뮬레이션이 빠른 작성 사다리 A로 진입했습니다."
      : "지원서 작성 시뮬레이션이 완전한 빠른 작성 경로에 진입하지 못했습니다.",
    [
      `mode ${input.workspaceMode}`,
      `ladder ${input.workspaceLadder}`,
      `active document ${input.activeDocumentKey ?? "없음"}`,
      `draft write ${input.draftId === null ? "없음" : "발생"}`,
      `conversion poll ${input.pollConversion ? "발생" : "없음"}`,
      `recovery ${input.recoveryNeeded ? "필요" : "불필요"}`,
    ],
  );
  return { deepPromotion, matchingCanary, fieldMaterialization, workspaceCanary };
}

export async function writeProductCanaryEvidence(
  evidence: ProductCanaryEvidence,
): Promise<string> {
  validateProductCanaryEvidence(evidence);
  const dir = productCanaryEvidenceDir(evidence.grantId, evidence.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${safeSegment(evidence.canaryId)}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

export async function readLatestProductCanaryEvidence(
  grantId: string,
  runId: string,
): Promise<ProductCanaryEvidence | null> {
  const dir = productCanaryEvidenceDir(grantId, runId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  let latest: ProductCanaryEvidence | null = null;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as unknown;
      validateProductCanaryEvidence(parsed);
      if (
        parsed.grantId === grantId
        && parsed.runId === runId
        && (!latest || parsed.evaluatedAt > latest.evaluatedAt)
      ) latest = parsed;
    } catch {
      // 손상되거나 다른 계약인 파일은 최신 증거 후보에서 제외한다.
    }
  }
  return latest;
}

export function buildProductCanaryId(now = new Date()): string {
  return `product-${now.toISOString().replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
}

export function validateProductCanaryEvidence(
  value: unknown,
): asserts value is ProductCanaryEvidence {
  if (!value || typeof value !== "object") throw new Error("제품 카나리 증거가 객체가 아닙니다.");
  const evidence = value as Partial<ProductCanaryEvidence>;
  if (
    evidence.schema !== PRODUCT_CANARY_EVIDENCE_SCHEMA
    || !nonempty(evidence.canaryId)
    || !nonempty(evidence.grantId)
    || !nonempty(evidence.runId)
    || !nonempty(evidence.releaseId)
    || !/^[a-f0-9]{64}$/.test(evidence.manifestSha256 ?? "")
    || !validDate(evidence.evaluatedAt)
    || !validNode(evidence.deepPromotion)
    || !validNode(evidence.matchingCanary)
    || !validNode(evidence.fieldMaterialization)
    || !validNode(evidence.workspaceCanary)
  ) throw new Error("제품 카나리 증거 형식이 올바르지 않습니다.");
}

function productCanaryEvidenceDir(grantId: string, runId: string): string {
  return join(analysisLabDir(), "product-canary", safeSegment(grantId), safeSegment(runId));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value: unknown): value is string {
  return nonempty(value) && !Number.isNaN(new Date(value).getTime());
}

function validNode(value: unknown): value is AnalysisQualityDownstreamEvidence {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<AnalysisQualityDownstreamEvidence>;
  return (node.status === "passed" || node.status === "failed")
    && nonempty(node.summary)
    && (node.evidence === undefined
      || (Array.isArray(node.evidence) && node.evidence.every(nonempty)));
}

function node(
  passed: boolean,
  summary: string,
  evidence: string[],
): AnalysisQualityDownstreamEvidence {
  return { status: passed ? "passed" : "failed", summary, evidence };
}

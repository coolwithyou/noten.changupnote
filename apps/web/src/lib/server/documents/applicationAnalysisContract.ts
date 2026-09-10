import { createHash } from "node:crypto";

/** 제품과 실험실이 공유하는 불변 분석 계약. 실행 경로나 모델 호출을 포함하지 않는다. */
export const APPLICATION_ROUNDTRIP_VERSION = "kordoc-application-roundtrip-v11";
export const ROUNDTRIP_FIELD_CANDIDATE_LIMIT = 180;
export const APPLICATION_PRECOMPUTE_VERSION_PREFIX = "kordoc-rhwp-application-precompute-v1";

export function buildApplicationPrecomputeAnalysisVersion(input: {
  contractVersion: string;
  engine: string;
  engineVersion: string;
  transport: "api" | "claude-cli";
  requestedModel: string;
  candidateLimit: number | null;
}): string {
  const identity = JSON.stringify({
    contractVersion: input.contractVersion,
    engine: input.engine,
    engineVersion: input.engineVersion,
    transport: input.transport,
    requestedModel: input.requestedModel,
    candidateLimit: input.candidateLimit,
  });
  return `${APPLICATION_PRECOMPUTE_VERSION_PREFIX}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

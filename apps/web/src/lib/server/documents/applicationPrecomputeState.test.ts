import assert from "node:assert/strict";
import { APPLICATION_ROUNDTRIP_VERSION } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  APPLICATION_PRECOMPUTE_ENGINE,
  APPLICATION_PRECOMPUTE_VERSION_PREFIX,
  parseApplicationPrecomputeState,
  shouldRecoverApplicationPrecompute,
} from "./applicationPrecomputeState";

const SOURCE_SHA = "a".repeat(64);
const currentMetadata = {
  engine: APPLICATION_PRECOMPUTE_ENGINE,
  resultStatus: "complete",
  sourceSha256: SOURCE_SHA,
  analysisVersion: `${APPLICATION_PRECOMPUTE_VERSION_PREFIX}:test`,
  contractVersion: APPLICATION_ROUNDTRIP_VERSION,
  fieldCount: 3,
  errorCode: null,
};

const current = parseApplicationPrecomputeState({
  artifactId: "artifact-current",
  metadata: currentMetadata,
  currentSourceSha256: SOURCE_SHA,
});
assert.equal(current?.current, true);
assert.equal(current?.status, "complete");
assert.equal(current?.fieldCount, 3);
assert.equal(shouldRecoverApplicationPrecompute(current, 3), false);

// current 완료 artifact인데 projection만 비어 있으면 사용자 진입 분석으로 한 번 복구한다.
assert.equal(shouldRecoverApplicationPrecompute(current, 0), true);

// 원본 SHA가 바뀐 artifact는 stale이며 복구 대상으로 판정한다.
const stale = parseApplicationPrecomputeState({
  artifactId: "artifact-stale",
  metadata: currentMetadata,
  currentSourceSha256: "b".repeat(64),
});
assert.equal(stale?.current, false);
assert.equal(shouldRecoverApplicationPrecompute(stale, 3), true);

// 사람 확인·대상 아님·실패는 모두 정상 종결이며 매 진입마다 재분석하지 않는다.
for (const resultStatus of ["review_required", "not_applicable", "failed"] as const) {
  const terminal = parseApplicationPrecomputeState({
    artifactId: `artifact-${resultStatus}`,
    metadata: { ...currentMetadata, resultStatus, fieldCount: 0 },
    currentSourceSha256: SOURCE_SHA,
  });
  assert.equal(terminal?.current, true);
  assert.equal(shouldRecoverApplicationPrecompute(terminal, 0), false);
}

assert.equal(parseApplicationPrecomputeState({
  artifactId: "artifact-invalid",
  metadata: { ...currentMetadata, engine: "unknown" },
  currentSourceSha256: SOURCE_SHA,
}), null);

console.log("application precompute state tests: ok");

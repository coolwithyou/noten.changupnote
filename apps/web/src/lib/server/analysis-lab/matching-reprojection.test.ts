import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabCriterion, LabRun } from "./lab-contract";
import {
  evaluateProjectionVerdicts,
  mergeLaunchTerminalTargets,
  projectRunCriteria,
  readVerifiedJsonArtifact,
  writeMatchingReprojectionReport,
  type LaunchReceiptTarget,
  type MatchingReprojectionReport,
} from "./matching-reprojection";

const moduleSource = await readFile(new URL("./matching-reprojection.ts", import.meta.url), "utf8");
const runtimeImports = [...moduleSource.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(runtimeImports, [
  "node:crypto",
  "node:fs/promises",
  "node:path",
  "@cunote/contracts",
  "@cunote/core/matching/match",
  "./lab-contract",
  "./shadow-convert",
], "진단 모듈은 로컬 파일·순수 계약/변환/matcher 외 DB·네트워크·live 모델 모듈을 import하지 않는다");

let networkStarts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  networkStarts += 1;
  throw new Error("matching reprojection must not start network access");
}) as typeof fetch;

function criterion(
  input: Partial<LabCriterion> & Pick<LabCriterion, "dimension" | "kind" | "operator" | "value">,
): LabCriterion {
  return {
    confidence: 0.9,
    sourceSpan: null,
    spanVerified: false,
    note: null,
    ...input,
  };
}

function fixtureRun(criteria: LabCriterion[]): LabRun {
  return {
    runId: "run-2026-09-07T000000.000Z-reprojection",
    grantId: "00000000-0000-4000-8000-000000000034",
    source: "bizinfo",
    sourceId: "PBLN_REPROJECTION",
    title: "재투영 테스트",
    model: "fixture-no-model-call",
    promptVersion: "fixture-v1",
    startedAt: "2026-09-07T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "0".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
  };
}

const manifestTargets = [
  { sequence: 0, grantId: "g-0", inputSha256: "i-0", attachmentManifestSha256: "a-0" },
  { sequence: 1, grantId: "g-1", inputSha256: "i-1", attachmentManifestSha256: "a-1" },
];
const firstTargets: LaunchReceiptTarget[] = [
  { sequence: 0, grantId: "g-0", status: "publishable", runArtifactPath: "run-0", runArtifactSha256: "sha-0" },
  { sequence: 1, grantId: "g-1", status: "failed", runArtifactPath: null, runArtifactSha256: null },
];
const retryTargets: LaunchReceiptTarget[] = [
  { sequence: 0, grantId: "g-0", status: "skipped", runArtifactPath: null, runArtifactSha256: null },
  { sequence: 1, grantId: "g-1", status: "publishable", runArtifactPath: "run-1", runArtifactSha256: "sha-1" },
];
const merged = mergeLaunchTerminalTargets(manifestTargets, [firstTargets, retryTargets]);
assert.equal(merged.get("g-0")?.status, "publishable", "skipped가 기존 terminal을 덮으면 안 된다");
assert.equal(merged.get("g-0")?.runArtifactSha256, "sha-0");
assert.equal(merged.get("g-1")?.status, "publishable", "새 non-skipped terminal은 이전 실패를 대체한다");

const run = fixtureRun([
  criterion({
    dimension: "industry",
    kind: "required",
    operator: "in",
    value: { tags: ["IT"] },
    sourceSpan: "모집직무: 경영·사무 / IT",
    note: "모집 직무 분야",
  }),
  criterion({
    dimension: "premises",
    kind: "preferred",
    operator: "in",
    value: { note: "화재에 취약한 건물 우선 지원" },
    sourceSpan: "화재에 취약한 건물 우선 지원",
  }),
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울특별시 소재 기업",
  }),
]);
const projection = projectRunCriteria(run);
assert.equal(projection.inputCriteria, 3);
assert.equal(projection.singleItemDropped, 1, "matcher 범위 밖 직무 조건은 원 index 0에서 단건 drop으로 기록");
assert.equal(projection.stableProjectionRows[0]?.projected, null);
assert.equal(
  projection.stableProjectionRows[1]?.projected?.kind,
  "preferred",
  "중간 drop 뒤 criterion도 llm-N 역산 없이 원 index 1에 안정적으로 결속",
);
assert.equal(
  projection.stableProjectionRows[2]?.projected?.dimension,
  "region",
  "후행 정상 criterion도 원 index 2에 결속",
);
assert.equal(projection.kindChanges, 0);
assert.equal(projection.matcherEligibilityChanges, 0);
assert.equal(projection.aggregateConverted, 2, "집합 projection은 단건 stable mapping과 별도로 전체 변환을 측정");
assert.equal(projection.aggregateDropped, 1);
assert.deepEqual(projection.aggregateAccountingIssues, []);
assert.deepEqual(projection.aggregateItems.map((item) => ({
  criterionIndex: item.criterionIndex,
  status: item.status,
  reason: item.reason,
  outputPosition: item.outputPosition,
})), [
  {
    criterionIndex: 0,
    status: "scope_rejected",
    reason: "program_job_field",
    outputPosition: null,
  },
  {
    criterionIndex: 1,
    status: "downgraded",
    reason: "reserved_dimension",
    outputPosition: 0,
  },
  {
    criterionIndex: 2,
    status: "converted",
    reason: null,
    outputPosition: 1,
  },
], "의도된 scope 제외와 강등도 원 index·사유·output 위치로 전량 설명한다");

const sameSpanDistinct = projectRunCriteria(fixtureRun([
  criterion({
    dimension: "premises",
    kind: "required",
    operator: "in",
    value: { note: "안산 본사 또는 공장" },
    sourceSpan: "안산 본사 또는 공장이면서 전년도 수출 2천만불 이하",
  }),
  criterion({
    dimension: "export_performance",
    kind: "required",
    operator: "lte",
    value: { max_usd: 20_000_000 },
    sourceSpan: "안산 본사 또는 공장이면서 전년도 수출 2천만불 이하",
  }),
]));
assert.equal(sameSpanDistinct.aggregateConverted, 2, "같은 근거 문장의 다른 축·값은 둘 다 보존한다");
assert.equal(sameSpanDistinct.aggregateDropped, 0);
assert.equal(sameSpanDistinct.aggregateError, null);
assert.deepEqual(sameSpanDistinct.aggregateAccountingIssues, []);

const trueDuplicate = projectRunCriteria(fixtureRun([
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울 소재 기업",
  }),
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울 소재 기업",
  }),
]));
assert.equal(trueDuplicate.aggregateConverted, 0);
assert.equal(trueDuplicate.aggregateDropped, 2);
assert.match(trueDuplicate.aggregateError ?? "", /duplicate_semantic_criterion/);
assert.deepEqual(trueDuplicate.aggregateItems.map((item) => ({
  criterionIndex: item.criterionIndex,
  status: item.status,
  relatedCriterionIndexes: item.relatedCriterionIndexes,
})), [
  { criterionIndex: 0, status: "held_duplicate", relatedCriterionIndexes: [1] },
  { criterionIndex: 1, status: "held_duplicate", relatedCriterionIndexes: [0] },
], "진짜 중복은 조용히 삭제하지 않고 양쪽 원 index를 결속해 명시 보류한다");
assert.deepEqual(evaluateProjectionVerdicts({
  singleItemDropped: 1,
  singleItemErrors: 0,
  aggregateDropped: 0,
  aggregateErrors: 0,
  kindChanges: 0,
  matcherEligibilityChanges: 0,
}), {
  singleItemProjectionVerdict: "REPORTED_FAILURES",
  kindPreservationVerdict: "FAIL",
  aggregateProjectionVerdict: "PASS",
  overallDiagnosticVerdict: "FAIL",
}, "단건 누락이 있으면 kind 0건만으로 의미 보존 PASS가 될 수 없다");
assert.equal(evaluateProjectionVerdicts({
  singleItemDropped: 0,
  singleItemErrors: 0,
  aggregateDropped: 1,
  aggregateErrors: 0,
  kindChanges: 0,
  matcherEligibilityChanges: 0,
}).aggregateProjectionVerdict, "REPORTED_FAILURES", "전체-run 누락도 PASS가 될 수 없다");

const temporaryRoot = await mkdtemp(join(tmpdir(), "cunote-matching-reprojection-"));
try {
  const artifactPath = join(temporaryRoot, "artifact.json");
  const artifactBytes = '{"ok":true}\n';
  await writeFile(artifactPath, artifactBytes);
  await assert.rejects(
    readVerifiedJsonArtifact(artifactPath, "0".repeat(64)),
    /artifact SHA-256 mismatch/,
    "원본 artifact SHA 불일치는 fail-closed해야 한다",
  );
  assert.deepEqual(
    await readVerifiedJsonArtifact(
      artifactPath,
      createHash("sha256").update(artifactBytes).digest("hex"),
    ),
    { ok: true },
  );

  const outputPath = join(temporaryRoot, "diagnostic.json");
  await writeFile(outputPath, "different-existing-bytes\n");
  await assert.rejects(
    writeMatchingReprojectionReport(
      { schema: "fixture" } as unknown as MatchingReprojectionReport,
      { root: temporaryRoot, outputPath },
    ),
    /already exists with different bytes/,
    "기존 진단 출력과 bytes가 다르면 덮어쓰지 않고 fail-closed해야 한다",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
assert.equal(networkStarts, 0, "단건/집합 재투영은 네트워크·모델 호출을 시작하지 않는다");
globalThis.fetch = originalFetch;

console.log("matching-reprojection tests: ok");

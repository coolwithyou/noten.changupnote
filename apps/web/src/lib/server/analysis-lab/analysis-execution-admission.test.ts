import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AnalysisLabExecutionPausedError,
  assertAnalysisLabCohortMutationAdmitted,
  assertAnalysisLabLiveExecutionAdmitted,
  assertAnalysisLabPromotionMutationAdmitted,
} from "./analysis-execution-admission";

assert.throws(
  () => assertAnalysisLabLiveExecutionAdmitted(),
  (error: unknown) =>
    error instanceof AnalysisLabExecutionPausedError
    && error.code === "gate_r_not_satisfied"
    && /createPlan\/replay/.test(error.message)
    && /모델 실행/.test(error.message),
  "Gate R 전 live 모델 실행은 환경변수나 lease만으로 열 수 없어야 한다",
);

assert.throws(
  () => assertAnalysisLabCohortMutationAdmitted(),
  (error: unknown) =>
    error instanceof AnalysisLabExecutionPausedError
    && error.code === "gate_r_not_satisfied"
    && /cohort mutation/.test(error.message),
  "Gate R 전 신규·대체 cohort 선정과 저장을 진행할 수 없어야 한다",
);

assert.throws(
  () => assertAnalysisLabPromotionMutationAdmitted(),
  (error: unknown) =>
    error instanceof AnalysisLabExecutionPausedError
    && error.code === "gate_r_not_satisfied"
    && /promotion mutation/.test(error.message),
  "Gate R 전 release approve/write도 정적 증거만으로 진행할 수 없어야 한다",
);

function cliSource(filename: string): string {
  return readFileSync(new URL(filename, import.meta.url), "utf8");
}

function assertAdmissionBeforeMutation(input: {
  filename: string;
  mutationNeedle: string;
  preservesDryRun?: boolean;
}): void {
  const source = cliSource(input.filename);
  const admission = source.indexOf("assertAnalysisLabLiveExecutionAdmitted();");
  const mutation = source.indexOf(input.mutationNeedle);
  assert.ok(admission >= 0, `${input.filename}: admission 호출이 필요하다`);
  assert.ok(mutation >= 0, `${input.filename}: mutation 경계가 존재해야 한다`);
  assert.ok(admission < mutation, `${input.filename}: admission은 mutation보다 먼저여야 한다`);
  if (input.preservesDryRun) {
    const dryRunReturn = source.indexOf("if (dryRun) return 0;");
    assert.ok(dryRunReturn >= 0 && dryRunReturn < admission, `${input.filename}: dry-run은 계속 허용한다`);
  }
}

assertAdmissionBeforeMutation({
  filename: "./quality-retry-cli.ts",
  mutationNeedle: "const { getCunoteDb }",
  preservesDryRun: true,
});
assertAdmissionBeforeMutation({
  filename: "./held-review-repair-cli.ts",
  mutationNeedle: "const { getCunoteDb }",
  preservesDryRun: true,
});
assertAdmissionBeforeMutation({
  filename: "./smoke.ts",
  mutationNeedle: "loadLabCohort({",
});
assertAdmissionBeforeMutation({
  filename: "../../../app/api/dev/analysis-lab/application-roundtrip/analyze/route.ts",
  mutationNeedle: "runWithLocalSubscriptionLeaseHeartbeat({",
});
assertAdmissionBeforeMutation({
  filename: "../../../app/api/dev/analysis-lab/analyze/route.ts",
  mutationNeedle: "runWithLocalSubscriptionLeaseHeartbeat({",
});
assertAdmissionBeforeMutation({
  filename: "../../../app/api/dev/analysis-lab/ops/batch/route.ts",
  mutationNeedle: "startLabBatchJob(parsed",
});
assertAdmissionBeforeMutation({
  filename: "../../../app/api/dev/analysis-lab/ops/runtime-control/route.ts",
  mutationNeedle: "const db = getCunoteDb();",
});

const cohortSource = cliSource("./cohort.ts");
const freezeStart = cohortSource.indexOf("export async function freezeLabCohortSnapshot(");
const loadStart = cohortSource.indexOf("export async function loadLabCohort(");
const reuseStart = cohortSource.indexOf("async function reuseStoredCohort(");
assert.ok(freezeStart >= 0 && loadStart > freezeStart && reuseStart > loadStart);
const freezeSource = cohortSource.slice(freezeStart, loadStart);
assert.ok(
  freezeSource.indexOf("assertAnalysisLabCohortMutationAdmitted();")
    < freezeSource.indexOf("const db = getCunoteDb();"),
  "immutable cohort freeze도 DB 선정 전에 Gate R을 검사한다",
);
const loadSource = cohortSource.slice(loadStart, reuseStart);
assert.match(
  loadSource,
  /if \(options\.refresh\) assertAnalysisLabCohortMutationAdmitted\(\);/,
  "refresh는 DB·파일 선정 전에 차단한다",
);
assert.match(
  loadSource,
  /else \{\s+assertAnalysisLabCohortMutationAdmitted\(\);\s+const fresh = await selectFreshCohort/,
  "missing/empty cohort의 신규 선정을 차단한다",
);
const reuseSource = cohortSource.slice(reuseStart);
assert.match(
  reuseSource,
  /if \(dead\.length === 0\) return stored;\s+assertAnalysisLabCohortMutationAdmitted\(\);/,
  "정상 조회는 유지하되 stale cohort 대체 선정은 차단한다",
);

console.log("analysis-lab execution admission tests: ok");

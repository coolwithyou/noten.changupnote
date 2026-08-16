import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisLabExecutionPausedError,
  assertAnalysisLabCohortMutationAdmitted,
  assertAnalysisLabLiveExecutionAdmitted,
} from "./analysis-execution-admission";
import { currentDeepRepairLiveExecutionBinding } from "./deep-repair-live-experiment";

assert.throws(
  () => assertAnalysisLabLiveExecutionAdmitted(),
  (error: unknown) =>
    error instanceof AnalysisLabExecutionPausedError
    && error.code === "gate_r_not_satisfied"
    && /createPlan\/replay/.test(error.message)
    && /모델 실행/.test(error.message),
  "Gate R 전 live 모델 실행은 환경변수나 lease만으로 열 수 없어야 한다",
);

assert.equal(
  currentDeepRepairLiveExecutionBinding(),
  null,
  "core가 검증한 prepared.execute callback 밖에서는 capability가 존재하지 않는다",
);

const webSourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
for (const filename of recursiveTypeScriptFiles(webSourceRoot)) {
  if (
    filename.endsWith(".test.ts")
    || filename.endsWith(".test.tsx")
  ) continue;
  const source = readFileSync(filename, "utf8");
  for (const unsafe of [
    {
      name: "buildClaudeCliFetchUnsafeForTest",
      definition: "/claude-cli-transport.ts",
    },
    {
      name: "startLabBatchJobUnsafeForTest",
      definition: "/batch-job.ts",
    },
  ]) {
    if (filename.endsWith(unsafe.definition)) continue;
    assert.ok(
      !source.includes(unsafe.name),
      `${filename}: test-only Gate 우회 import/call 금지(${unsafe.name})`,
    );
  }
  if (
    !filename.endsWith("/deep-repair-live-experiment.ts")
    && !filename.endsWith("/deep-repair-live-production.ts")
  ) {
    assert.ok(
      !source.includes("createDeepRepairLiveExperiment"),
      `${filename}: live execution context를 여는 core factory는 고정 production 조합만 사용할 수 있다`,
    );
  }
}

for (const promotionFile of [
  "./promotion-release-cli.ts",
  "./promotion-aggregate-cli.ts",
  "./promotion-mutation-admission.ts",
  "./promote-cli.ts",
  "./shadow.ts",
]) {
  const source = readFileSync(new URL(promotionFile, import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /analysis-execution-admission|assertAnalysisLabLiveExecutionAdmitted|gate_r_not_satisfied/,
    `${promotionFile}: live 모델 Gate를 promotion release 처리 권한으로 전이하면 안 된다`,
  );
}

assert.throws(
  () => assertAnalysisLabCohortMutationAdmitted(),
  (error: unknown) =>
    error instanceof AnalysisLabExecutionPausedError
    && error.code === "gate_r_not_satisfied"
    && /cohort mutation/.test(error.message),
  "Gate R 전 신규·대체 cohort 선정과 저장을 진행할 수 없어야 한다",
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

function recursiveTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...recursiveTypeScriptFiles(path));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(path);
    }
  }
  return files;
}

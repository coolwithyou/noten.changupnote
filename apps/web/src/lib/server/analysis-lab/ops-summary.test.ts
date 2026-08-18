// ops-summary 테스트 — 런 스캐너(이중 방어·transport 분포)와 깔때기 조립(순수부)만 검증한다.
// DB 카운트(①②⑥)는 LabOpsDbCounts 주입점 뒤라 범위 밖(통합 테스트 아님 — 계획 §3-2 검증 계약).
// 실행: pnpm lab:ops-summary:test
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/lib/server/analysis-lab/lab-contract";
import { partitionCohortEntries } from "./batch-plan";
import type { CohortEntry, CohortFileV2 } from "./cohort-file";
import { buildLabOpsFunnel, scanLabRunsForOps, type LabOpsDbCounts } from "./ops-summary";

const OUTDATED_PROMPT_VERSION = "lab-deep-v2";
assert.notEqual(OUTDATED_PROMPT_VERSION, ANALYSIS_LAB_PROMPT_VERSION, "구버전 픽스처 전제 확인");

interface RunFixture {
  grantId: string;
  promptVersion?: string;
  primaryValidationOutcome?: "publishable" | "held";
  error?: string | null;
  transport?: "api" | "claude-cli";
  /** false 면 startedAt 을 고의로 뺀다(이중 방어 ② 검증용). */
  withStartedAt?: boolean;
}

function runBody(fixture: RunFixture): string {
  const body: Record<string, unknown> = {
    runId: "run-fixture",
    grantId: fixture.grantId,
    promptVersion: fixture.promptVersion ?? ANALYSIS_LAB_PROMPT_VERSION,
    error: fixture.error ?? null,
  };
  if (fixture.primaryValidationOutcome !== undefined) {
    body.primaryValidationOutcome = fixture.primaryValidationOutcome;
  }
  if (fixture.withStartedAt !== false) body.startedAt = "2026-08-01T00:00:00.000Z";
  if (fixture.transport !== undefined) body.transport = fixture.transport;
  return JSON.stringify(body);
}

// ---- ① 런 스캐너 — 픽스처 디렉터리(임시 폴더)로 이중 방어·transport 분포 검증 ------

{
  const root = await mkdtemp(join(tmpdir(), "ops-summary-test-"));
  try {
    // 루트의 파일("__" 없음)은 스캔 대상이 아니다 — cohort.json 자리 재현.
    await writeFile(join(root, "cohort.json"), "{}", "utf8");

    const dirA = join(root, "kstartup__A1");
    await mkdir(dirA, { recursive: true });
    // g1: 현행 ok 런 2건 — transport claude-cli 1건 + 미기록(구런 → api 해석) 1건.
    await writeFile(
      join(dirA, "run-2026-08-01T000000.000Z-aaaaaa.json"),
      runBody({ grantId: "g1", transport: "claude-cli" }),
      "utf8",
    );
    await writeFile(
      join(dirA, "run-2026-08-01T000001.000Z-bbbbbb.json"),
      runBody({ grantId: "g1" }),
      "utf8",
    );
    // g2: 구버전 ok 런만.
    await writeFile(
      join(dirA, "run-2026-08-01T000002.000Z-cccccc.json"),
      runBody({ grantId: "g2", promptVersion: OUTDATED_PROMPT_VERSION }),
      "utf8",
    );
    // g3: 현행 error 런만.
    await writeFile(
      join(dirA, "run-2026-08-01T000003.000Z-dddddd.json"),
      runBody({ grantId: "g3", error: "boom" }),
      "utf8",
    );
    // 이중 방어 ① 함정 — 런과 똑같은 본문(startedAt 포함)을 가진 사이드카들. 파일명으로
    // 걸러지지 않으면 g4 가 okCurrent 로 오염된다(e4556df 오인 편입 전례 재현).
    for (const sidecar of [
      "run-2026-08-01T000004.000Z-eeeeee.ai-review.claude-fable-5.json",
      "run-2026-08-01T000004.000Z-eeeeee.audit.claude-fable-5.json",
      "run-2026-08-01T000004.000Z-eeeeee.confirmations.json",
      "run-2026-08-01T000004.000Z-eeeeee.review.json",
      "run-2026-08-01T000004.000Z-eeeeee.human-overlay.json",
    ]) {
      await writeFile(join(dirA, sidecar), runBody({ grantId: "g4", transport: "claude-cli" }), "utf8");
    }
    // 이중 방어 ② 함정 — 파일명은 런인데 startedAt 이 없다(부속 파일 표식 부재).
    await writeFile(
      join(dirA, "run-2026-08-01T000005.000Z-ffffff.json"),
      runBody({ grantId: "g4", withStartedAt: false }),
      "utf8",
    );
    // 깨진 JSON — 조용히 제외.
    await writeFile(join(dirA, "run-2026-08-01T000006.000Z-000000.json"), "{", "utf8");

    // g5: 코호트 밖 공고 — states 에는 들어가되 transport 분포에서는 제외돼야 한다.
    const dirB = join(root, "bizinfo__B2");
    await mkdir(dirB, { recursive: true });
    await writeFile(
      join(dirB, "run-2026-08-01T000007.000Z-999999.json"),
      runBody({ grantId: "g5", transport: "claude-cli" }),
      "utf8",
    );
    // g6: 신규 형식 primary held(error:null) · g7: 구 sentinel held.
    await writeFile(
      join(dirB, "run-2026-08-01T000008.000Z-888888.json"),
      runBody({ grantId: "g6", primaryValidationOutcome: "held" }),
      "utf8",
    );
    await writeFile(
      join(dirB, "run-2026-08-01T000009.000Z-777777.json"),
      runBody({ grantId: "g7", error: "primary_validation_held: $.axis_assessments.size" }),
      "utf8",
    );
    // g8: 같은 현행 prompt의 과거 publishable 뒤 최신 held. 모든 런을 OR하면 ok+held가
    // 동시에 켜져 partition에서 publishable로 오분류된다. 최신 품질 종결만 권위가 있다.
    await writeFile(
      join(dirB, "run-2026-08-01T000010.000Z-666666.json"),
      runBody({ grantId: "g8", transport: "claude-cli" }),
      "utf8",
    );
    await writeFile(
      join(dirB, "run-2026-08-01T000011.000Z-555555.json"),
      runBody({ grantId: "g8", primaryValidationOutcome: "held", transport: "claude-cli" }),
      "utf8",
    );
    await writeFile(
      join(dirB, "run-2026-08-01T000012.000Z-444444.json"),
      runBody({ grantId: "g8", error: "provider timeout", transport: "claude-cli" }),
      "utf8",
    );

    const cohortGrantIds = new Set(["g1", "g2", "g3", "g4", "g6", "g7", "g8"]);
    const scan = await scanLabRunsForOps(root, cohortGrantIds);

    assert.deepEqual(
      scan.states.get("g1"),
      { okCurrent: true, okOutdated: false, heldCurrent: false, errorCurrent: false },
      "g1 — 현행 ok",
    );
    assert.deepEqual(
      scan.states.get("g2"),
      { okCurrent: false, okOutdated: true, heldCurrent: false, errorCurrent: false },
      "g2 — 구버전 ok 만",
    );
    assert.deepEqual(
      scan.states.get("g3"),
      { okCurrent: false, okOutdated: false, heldCurrent: false, errorCurrent: true },
      "g3 — 현행 error 만",
    );
    assert.equal(
      scan.states.has("g4"),
      false,
      "g4 — 사이드카(파일명)·startedAt 부재(본문) 이중 방어로 런 미인정",
    );
    assert.deepEqual(
      scan.states.get("g5"),
      { okCurrent: true, okOutdated: false, heldCurrent: false, errorCurrent: false },
      "g5 — 코호트 밖이어도 states 에는 포함",
    );
    assert.deepEqual(
      scan.states.get("g6"),
      { okCurrent: false, okOutdated: false, heldCurrent: true, errorCurrent: false },
      "g6 — 신규 held(error:null)",
    );
    assert.deepEqual(
      scan.states.get("g7"),
      { okCurrent: false, okOutdated: false, heldCurrent: true, errorCurrent: false },
      "g7 — 구 held sentinel 호환",
    );
    assert.deepEqual(
      scan.states.get("g8"),
      { okCurrent: false, okOutdated: false, heldCurrent: true, errorCurrent: false },
      "g8 — 과거 publishable을 최신 held가 대체하고 이후 provider 실패는 종결을 지우지 않음",
    );
    assert.deepEqual(
      scan.runsByTransport,
      { api: 1, claudeCli: 0 },
      "transport 분포 — grant별 최신 현행 publishable만 집계하고 최신 held인 g8은 제외",
    );
    console.log("✅ 런 스캐너 — 이중 방어(사이드카·startedAt)·transport 분포·코호트 한정");

    // ---- ② 스캔 결과 → partitionCohortEntries 접속(④ 4버킷) -------------------------
    const entries: CohortEntry[] = ["g1", "g2", "g3", "g4", "g6", "g7"].map((grantId) => ({
      grantId,
      stratum: "pilot",
    }));
    const partition = partitionCohortEntries(entries, scan.states, {
      retryErrors: false,
      reanalyzeOutdated: false,
    });
    assert.deepEqual(partition.skippedOk.map((entry) => entry.grantId), ["g1", "g2"]);
    assert.deepEqual(partition.skippedOkOutdatedOnly.map((entry) => entry.grantId), ["g2"]);
    assert.deepEqual(partition.heldError.map((entry) => entry.grantId), ["g3"]);
    assert.deepEqual(partition.skippedHeld.map((entry) => entry.grantId), ["g6", "g7"]);
    assert.deepEqual(partition.pending.map((entry) => entry.grantId), ["g4"]);
    console.log("✅ 스캔 → partitionCohortEntries — ④ 4버킷 접속");

    // ---- ③ 깔때기 조립(순수부) — DB 카운트는 주입 ------------------------------------
    const dbCounts: LabOpsDbCounts = {
      archivedVisible: 120,
      archivedVisibleLabSources: 100,
      openToday: 40,
      periodUnknown: 7,
      promotedGrants: 5,
    };
    const cohort: CohortFileV2 = {
      version: 2,
      selectedAt: "2026-08-01T00:00:00.000Z",
      seed: 42,
      experimentLabel: "expansion-s1",
      entries,
    };
    const funnel = buildLabOpsFunnel({
      dbCounts,
      cohort,
      partition,
      humanReviewedCount: 30,
      auditConfirmedProvenances: [{ auditedCount: 2 }, { auditedCount: 0 }, { auditedCount: 0 }],
      auditPendingCount: 4,
    });
    assert.deepEqual(funnel, {
      archivedVisible: 120,
      archivedVisibleLabSources: 100,
      openToday: 40,
      periodUnknown: 7,
      closedOrNotStarted: 53, // 100 - 40 - 7
      cohortSize: 6,
      cohortLabel: "expansion-s1",
      cohortSelectedAt: "2026-08-01T00:00:00.000Z",
      analysisOkCurrent: 1, // skippedOk 2 - 구버전만 1
      analysisOkOutdatedOnly: 1,
      analysisValidationHeld: 2,
      analysisErrorHeld: 1,
      analysisPending: 1,
      humanReviewed: 30,
      auditConfirmed: 1, // auditedCount>0 — 사람 판정 포함 확정
      auditAiAutoConfirmed: 2, // auditedCount=0 — AI 블라인드 감사 자동 확정(무은폐 분리)
      auditPending: 4,
      promotedGrants: 5,
    });
    console.log("✅ 깔때기 조립 — ②차감·③메타·④버킷·⑤3분할+대기·⑥승격");

    // 코호트 파일 부재 + 차감 음수 방어 + selectedAt 공백 정규화.
    const emptyFunnel = buildLabOpsFunnel({
      dbCounts: { ...dbCounts, archivedVisibleLabSources: 30 }, // 40+7 > 30 — clamp 검증
      cohort: null,
      partition: partitionCohortEntries([], new Map(), { retryErrors: false, reanalyzeOutdated: false }),
      humanReviewedCount: 0,
      auditConfirmedProvenances: [],
      auditPendingCount: 0,
    });
    assert.equal(emptyFunnel.closedOrNotStarted, 0, "차감 음수는 0 으로 clamp");
    assert.equal(emptyFunnel.cohortSize, 0);
    assert.equal(emptyFunnel.cohortLabel, null);
    assert.equal(emptyFunnel.cohortSelectedAt, null);
    assert.equal(emptyFunnel.analysisPending, 0);
    const blankSelectedAt = buildLabOpsFunnel({
      dbCounts,
      cohort: { version: 2, selectedAt: "", seed: null, experimentLabel: null, entries: [] },
      partition: partitionCohortEntries([], new Map(), { retryErrors: false, reanalyzeOutdated: false }),
      humanReviewedCount: 0,
      auditConfirmedProvenances: [],
      auditPendingCount: 0,
    });
    assert.equal(blankSelectedAt.cohortSelectedAt, null, "selectedAt 빈 문자열은 null 정규화");
    console.log("✅ 경계 — 코호트 부재·차감 clamp·selectedAt 정규화");
  } finally {
    // Cowork 샌드박스는 unlink 가 차단될 수 있다 — 정리 실패는 테스트 실패가 아니다.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("\nops-summary 테스트 전부 통과");

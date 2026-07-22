// 공모 딥분석 실험실 — AI 검수 캘리브레이션 비교·감사 표본 추출 (순수 함수, DB·네트워크·IO 미사용).
// 확대 실험 계획 §9(2026-07-23 프로토콜 개정)의 사전 등록 채택 기준을 코드로 옮긴 단일 원천:
//   - criterion verdict 정확 일치 ≥ 24/28 (85.7%)
//   - 사람 correct → AI wrong 방향 오검출 ≤ 2건
//   - 빈 축: 사람 confirmed_absent 와의 일치 ≥ 42/46
//   - AI 의 추가 missed_condition 플래그는 실격 사유가 아니라 "사람 미확인 후보"로만 기록
// 감사 표본(§9 감사 설계): ① AI 비-correct 전수 ② missed_condition 플래그 전수
// ③ correct 중 시드 고정 결정론 무작위 20%.
import type { CriterionDimension } from "@cunote/contracts";
import type {
  LabAuditReason,
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
} from "@/features/dev/analysis-lab/contract";
import { seededRandom } from "./cohort-file";

/** AI 검수기의 criterion 1건 판정 — LabCriterionReview 와 같은 어휘(검수 시트 계약 공유). */
export interface AiCriterionReview {
  criterionIndex: number;
  verdict: LabCriterionVerdict;
  note: string | null;
}

/** AI 검수기의 빈 축 1건 판정 — LabAxisReview 와 같은 어휘. */
export interface AiAxisReview {
  dimension: CriterionDimension;
  verdict: LabEmptyAxisVerdict;
  note: string | null;
}

/** verdict 고정 순서 — confusion matrix 행/열 인덱스의 단일 원천. */
export const CRITERION_VERDICT_ORDER: readonly LabCriterionVerdict[] = [
  "correct",
  "needs_edit",
  "wrong",
  "unsure",
];

/** §9 사전 등록 채택 기준(사후 변경 금지) — 절대 건수 기준. */
export const CALIBRATION_ADOPTION_CRITERIA = {
  minCriterionExactMatches: 24,
  expectedCriterionTotal: 28,
  maxCorrectToWrong: 2,
  minAxisAgreement: 42,
  expectedAxisHumanConfirmedTotal: 46,
} as const;

/** 한 런(공고)의 사람 vs AI 판정 쌍 — 비교 입력. */
export interface RunComparisonInput {
  grantId: string;
  runId: string;
  title: string;
  humanCriterionReviews: Array<{ criterionIndex: number; verdict: LabCriterionVerdict; note: string | null }>;
  humanAxisReviews: Array<{ dimension: CriterionDimension; verdict: LabEmptyAxisVerdict; note: string | null }>;
  aiCriterionReviews: AiCriterionReview[];
  aiAxisReviews: AiAxisReview[];
}

export interface CriterionMismatch {
  grantId: string;
  runId: string;
  title: string;
  criterionIndex: number;
  humanVerdict: LabCriterionVerdict;
  humanNote: string | null;
  aiVerdict: LabCriterionVerdict;
  aiNote: string | null;
}

/** 사람 confirmed_absent 축에 대한 AI 불일치(missed_condition 또는 AI 미판정). */
export interface AxisMismatch {
  grantId: string;
  runId: string;
  title: string;
  dimension: CriterionDimension;
  /** AI 판정 — 해당 축의 AI 판정이 아예 없으면 null(정상 흐름에선 없어야 함). */
  aiVerdict: LabEmptyAxisVerdict | null;
  aiNote: string | null;
}

/** 사람이 판정하지 않은 빈 축에 대한 AI missed_condition — 실격 아님, 사람 미확인 후보. */
export interface ExtraMissedFlag {
  grantId: string;
  runId: string;
  title: string;
  dimension: CriterionDimension;
  aiNote: string | null;
}

export interface CalibrationReport {
  /** 4×4 confusion matrix — 행: 사람 verdict, 열: AI verdict (CRITERION_VERDICT_ORDER 순). */
  confusion: number[][];
  /** 사람·AI 양쪽이 판정한 criterion 수(비교 분모). */
  criterionTotal: number;
  exactMatches: number;
  /** 사람 correct → AI wrong 방향 오검출 수. */
  correctToWrong: number;
  criterionMismatches: CriterionMismatch[];
  /** 사람이 판정했는데 AI 판정이 없는 criterion 수(커버리지 결함 신호 — 정상 흐름 0). */
  humanOnlyCriterionCount: number;
  /** 사람 confirmed_absent 축 수(빈 축 일치의 분모). */
  axisHumanConfirmedTotal: number;
  /** 사람 confirmed_absent ∧ AI confirmed_absent 축 수. */
  axisAgreement: number;
  axisMismatches: AxisMismatch[];
  /** 사람 missed_condition 축(§9 분모 밖 — 참고 표시용. 파일럿엔 0건). */
  humanMissedAxes: Array<{ dimension: CriterionDimension; grantId: string; aiVerdict: LabEmptyAxisVerdict | null }>;
  extraMissedFlags: ExtraMissedFlag[];
}

function verdictIndex(verdict: LabCriterionVerdict): number {
  return CRITERION_VERDICT_ORDER.indexOf(verdict);
}

/** 사람 검수(골든) vs AI 검수 비교 집계 — 여러 런을 합산한 캘리브레이션 리포트. */
export function compareCalibration(runs: RunComparisonInput[]): CalibrationReport {
  const confusion = CRITERION_VERDICT_ORDER.map(() => CRITERION_VERDICT_ORDER.map(() => 0));
  let criterionTotal = 0;
  let exactMatches = 0;
  let correctToWrong = 0;
  let humanOnlyCriterionCount = 0;
  const criterionMismatches: CriterionMismatch[] = [];

  let axisHumanConfirmedTotal = 0;
  let axisAgreement = 0;
  const axisMismatches: AxisMismatch[] = [];
  const humanMissedAxes: CalibrationReport["humanMissedAxes"] = [];
  const extraMissedFlags: ExtraMissedFlag[] = [];

  for (const run of runs) {
    const aiByIndex = new Map(run.aiCriterionReviews.map((item) => [item.criterionIndex, item]));
    for (const human of run.humanCriterionReviews) {
      const ai = aiByIndex.get(human.criterionIndex);
      if (!ai) {
        humanOnlyCriterionCount += 1;
        continue;
      }
      criterionTotal += 1;
      confusion[verdictIndex(human.verdict)]![verdictIndex(ai.verdict)]! += 1;
      if (human.verdict === ai.verdict) {
        exactMatches += 1;
      } else {
        if (human.verdict === "correct" && ai.verdict === "wrong") correctToWrong += 1;
        criterionMismatches.push({
          grantId: run.grantId,
          runId: run.runId,
          title: run.title,
          criterionIndex: human.criterionIndex,
          humanVerdict: human.verdict,
          humanNote: human.note,
          aiVerdict: ai.verdict,
          aiNote: ai.note,
        });
      }
    }

    const aiByDimension = new Map(run.aiAxisReviews.map((item) => [item.dimension, item]));
    const humanDimensions = new Set(run.humanAxisReviews.map((item) => item.dimension));
    for (const human of run.humanAxisReviews) {
      const ai = aiByDimension.get(human.dimension) ?? null;
      if (human.verdict === "missed_condition") {
        // §9 분모(confirmed_absent 46) 밖 — 참고로만 기록한다.
        humanMissedAxes.push({ dimension: human.dimension, grantId: run.grantId, aiVerdict: ai?.verdict ?? null });
        continue;
      }
      axisHumanConfirmedTotal += 1;
      if (ai?.verdict === "confirmed_absent") {
        axisAgreement += 1;
      } else {
        axisMismatches.push({
          grantId: run.grantId,
          runId: run.runId,
          title: run.title,
          dimension: human.dimension,
          aiVerdict: ai?.verdict ?? null,
          aiNote: ai?.note ?? null,
        });
      }
    }
    for (const ai of run.aiAxisReviews) {
      if (ai.verdict !== "missed_condition") continue;
      if (humanDimensions.has(ai.dimension)) continue; // 사람 판정 축은 위 불일치 경로에서 처리됨.
      // 사람이 판정하지 않은 빈 축(예: 파일럿 식품 export_performance) — 누락 "후보"로만 기록.
      extraMissedFlags.push({
        grantId: run.grantId,
        runId: run.runId,
        title: run.title,
        dimension: ai.dimension,
        aiNote: ai.note,
      });
    }
  }

  return {
    confusion,
    criterionTotal,
    exactMatches,
    correctToWrong,
    criterionMismatches,
    humanOnlyCriterionCount,
    axisHumanConfirmedTotal,
    axisAgreement,
    axisMismatches,
    humanMissedAxes,
    extraMissedFlags,
  };
}

export interface AdoptionCheckLine {
  name: string;
  actual: string;
  target: string;
  pass: boolean;
}

export interface AdoptionJudgment {
  pass: boolean;
  lines: AdoptionCheckLine[];
  /** 비교 분모가 §9 등재 시점 수치(28/46)와 다르면 경고(기준은 절대 건수라 판정은 그대로 적용). */
  totalsWarning: string | null;
}

/** §9 사전 등록 채택 기준 자동 판정 — 절대 건수 기준을 그대로 적용한다. */
export function judgeAdoption(report: {
  criterionTotal: number;
  exactMatches: number;
  correctToWrong: number;
  axisHumanConfirmedTotal: number;
  axisAgreement: number;
}): AdoptionJudgment {
  const c = CALIBRATION_ADOPTION_CRITERIA;
  const lines: AdoptionCheckLine[] = [
    {
      name: "criterion verdict 정확 일치",
      actual: `${report.exactMatches}/${report.criterionTotal}`,
      target: `≥ ${c.minCriterionExactMatches}/${c.expectedCriterionTotal}`,
      pass: report.exactMatches >= c.minCriterionExactMatches,
    },
    {
      name: "사람 correct → AI wrong 오검출",
      actual: `${report.correctToWrong}건`,
      target: `≤ ${c.maxCorrectToWrong}건`,
      pass: report.correctToWrong <= c.maxCorrectToWrong,
    },
    {
      name: "빈 축 confirmed_absent 일치",
      actual: `${report.axisAgreement}/${report.axisHumanConfirmedTotal}`,
      target: `≥ ${c.minAxisAgreement}/${c.expectedAxisHumanConfirmedTotal}`,
      pass: report.axisAgreement >= c.minAxisAgreement,
    },
  ];
  const totalsWarning =
    report.criterionTotal !== c.expectedCriterionTotal ||
    report.axisHumanConfirmedTotal !== c.expectedAxisHumanConfirmedTotal
      ? `비교 분모(criterion ${report.criterionTotal}, 빈 축 ${report.axisHumanConfirmedTotal})가 §9 등재 수치(${c.expectedCriterionTotal}/${c.expectedAxisHumanConfirmedTotal})와 다릅니다 — 대상 선정·파일 정합을 확인하세요.`
      : null;
  return { pass: lines.every((line) => line.pass), lines, totalsWarning };
}

// ---- 감사 표본 추출 (§9 감사 설계) ----------------------------------------------

/**
 * 감사 표본의 시드·비율 — §9 감사 설계("correct 시드 42 결정론 20%")의 단일 원천.
 * CLI(--audit-list)와 감사 파일 생성(audit-store)이 같은 값을 써야 같은 대상이 나온다.
 */
export const AUDIT_SEED = 42;
export const AUDIT_SAMPLE_RATIO = 0.2;

/** 감사 대상 종류 — 감사 기록 계약(contract 의 LabAuditReason)과 동일 어휘의 별칭. */
export type AuditTargetKind = LabAuditReason;

export interface AuditTarget {
  kind: AuditTargetKind;
  grantId: string;
  runId: string;
  title: string;
  /** criterion 대상이면 인덱스, 빈 축 대상이면 undefined. */
  criterionIndex?: number;
  /** 빈 축 대상이면 축, criterion 대상이면 undefined. */
  dimension?: CriterionDimension;
  aiVerdict: string;
  aiNote: string | null;
}

export interface AiReviewForAudit {
  grantId: string;
  runId: string;
  title: string;
  criterionReviews: AiCriterionReview[];
  axisReviews: AiAxisReview[];
}

export interface AuditSelection {
  targets: AuditTarget[];
  correctTotal: number;
  sampledCorrectCount: number;
}

/**
 * 사람 감사 대상 산출 — ① AI 비-correct 판정 전수 ② missed_condition 플래그 전수
 * ③ correct 중 시드 고정 결정론 무작위 표본(기본 20%).
 * 입력 순서와 무관하게 같은 시드면 같은 표본이 나온다(정렬 후 시드 셔플).
 */
export function selectAuditTargets(
  reviews: AiReviewForAudit[],
  options: { seed: number; sampleRatio: number },
): AuditSelection {
  const nonCorrect: AuditTarget[] = [];
  const flags: AuditTarget[] = [];
  const correctPool: AuditTarget[] = [];

  const sortKey = (target: AuditTarget): string =>
    `${target.grantId}|${target.runId}|${target.criterionIndex ?? ""}|${target.dimension ?? ""}`;

  for (const review of reviews) {
    for (const item of review.criterionReviews) {
      const target: AuditTarget = {
        kind: item.verdict === "correct" ? "correct_sample" : "ai_non_correct",
        grantId: review.grantId,
        runId: review.runId,
        title: review.title,
        criterionIndex: item.criterionIndex,
        aiVerdict: item.verdict,
        aiNote: item.note,
      };
      if (item.verdict === "correct") correctPool.push(target);
      else nonCorrect.push(target);
    }
    for (const item of review.axisReviews) {
      if (item.verdict !== "missed_condition") continue;
      flags.push({
        kind: "missed_condition_flag",
        grantId: review.grantId,
        runId: review.runId,
        title: review.title,
        dimension: item.dimension,
        aiVerdict: item.verdict,
        aiNote: item.note,
      });
    }
  }

  nonCorrect.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  flags.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  correctPool.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // 결정론 표본: 정렬된 풀을 시드 고정 Fisher–Yates 로 셔플하고 앞에서 ceil(n×ratio)개.
  const rng = seededRandom(options.seed);
  const shuffled = [...correctPool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = a;
  }
  const sampleCount = correctPool.length === 0 ? 0 : Math.ceil(correctPool.length * options.sampleRatio);
  const sampled = shuffled.slice(0, sampleCount).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  return {
    targets: [...nonCorrect, ...flags, ...sampled],
    correctTotal: correctPool.length,
    sampledCorrectCount: sampled.length,
  };
}

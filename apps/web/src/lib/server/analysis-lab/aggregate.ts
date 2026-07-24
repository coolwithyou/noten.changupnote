// 공모 딥분석 실험실 — 검수 집계·통과 기준 판정 CLI (dev 전용, DB·네트워크 미사용).
// spike-out/analysis-lab/ 의 <runId>.review.json 을 런과 짝짓고, 기본은 cohort.json
// (cohort-file.ts, v1 은 stratum "pilot" 로 정규화)의 코호트 공고만 집계하되, 검수 보존
// 가드로 코호트 안에 남은 파일럿 층(stratum=pilot)은 게이트 판정 표본에서 추가 제외한다
// (확대 계획 §3 사전 등록 — 구조화 게이트 수치를 유도한 데이터의 재진입 순환 차단).
// --all 이면 전수 스캔(파일럿 포함치 — 민감도 참고), cohort.json 이 없으면 전수 폴백한다.
// 정밀도(criterion 판정)·재현율(빈 축 누락)·커버리지(확정 B vs 현행 A)·비용·구조화 비율을
// 집계해 통과 기준(GATES 6종)에 대해 자동 판정한다. 구조화 비율(정확 확정 B 중
// operator≠text_only)은 파일럿 후 게이트로 승격됐고, A→B 배수는 관찰 지표로 유지(게이트 아님).
// 코호트 층(stratum)별 분해 표는 진단용 — 게이트 판정은 전역 집계로만 한다.
// 정밀도·구조화 비율에는 Wilson 95% CI 를 병기한다(판정 자체는 점추정 유지 —
// 신뢰한계 판정 도입 여부는 확대 실험 판정 문서의 몫).
// 위치 진단(제안 근거 위치 분포 — lost-in-the-middle 관찰)은 종합 아래 병기한다(게이트 아님).
// 기본 출력은 공고당 1줄 요약(30~100건 스케일 대비), 상세 블록은 --verbose.
// 검수 런 수집·코호트 필터·dedupe 는 reviewed-runs.ts 공유 모듈(섀도 측정과 공용)을 쓴다.
// 실행: pnpm lab:aggregate [--all] [--verbose]
import {
  AI_REVIEW_ADOPTED,
  ANALYSIS_LAB_GATES as GATES,
  type LabReview,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  loadAuditedConfirmedReviews,
  type AuditedReviewProvenance,
} from "./audited-reviews";
import type { CohortFileV2 } from "./cohort-file";
import { verifyPromotionSourceArtifact } from "./promotion-candidates";
import {
  promotionReleaseArtifactPath,
  readPromotionReleaseManifest,
  writeImmutablePromotionArtifact,
} from "./promotion-release";
import { type ReviewedRun, selectReviewedRuns } from "./reviewed-runs";

/** --all 전수 스캔에서 코호트에 없는 공고의 층 표기. */
const OUTSIDE_STRATUM = "(코호트 외)";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Wilson score 95% 신뢰구간 [하한, 상한] — 소표본 비율의 불확실성 감각용.
 * 게이트 판정은 점추정으로만 하고 CI 는 병기 출력한다(신뢰한계 기반 판정 도입은
 * 확대 실험 판정 문서의 몫). trials 0 이면 정보 없음 → [0, 1].
 */
function wilsonCi95(successes: number, trials: number): [number, number] {
  if (trials === 0) return [0, 1];
  const z = 1.96;
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (phat + (z * z) / (2 * trials)) / denom;
  const half =
    (z * Math.sqrt((phat * (1 - phat)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function ciText(successes: number, trials: number): string {
  const [low, high] = wilsonCi95(successes, trials);
  return `95% CI ${pct(low)}~${pct(high)}`;
}

function gateLine(name: string, actual: string, target: string, pass: boolean): string {
  return `  ${pass ? "✅ 통과" : "❌ 미달"} | ${name}: ${actual} (기준 ${target})`;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function aggregateRelease(releaseId: string): Promise<void> {
  const manifest = await readPromotionReleaseManifest(releaseId);
  const plans = manifest.plans;
  if (plans.length === 0) throw new Error("release manifest plan이 0건입니다.");
  const correct = plans.reduce((sum, item) => sum + item.promotionPlan.conversion.verdicts.correct, 0);
  const needsEdit = plans.reduce(
    (sum, item) => sum + item.promotionPlan.conversion.verdicts.needs_edit,
    0,
  );
  const wrong = plans.reduce((sum, item) => sum + item.promotionPlan.conversion.verdicts.wrong, 0);
  const unsure = plans.reduce((sum, item) => sum + item.promotionPlan.conversion.verdicts.unsure, 0);
  const missed = plans.reduce(
    (sum, item) => sum + item.promotionPlan.conversion.missedConditions,
    0,
  );
  const currentTotal = plans.reduce((sum, item) => sum + item.criteriaCountBefore, 0);
  const structured = plans.reduce(
    (sum, item) => sum + item.promotionPlan.criteria
      .filter((criterion) => criterion.operator !== "text_only").length,
    0,
  );
  const costs = plans.map((item) => item.costUsd).filter((cost): cost is number => cost !== null);
  const decided = correct + needsEdit + wrong + unsure;
  const strictPrecision = decided > 0 ? correct / decided : 0;
  const wrongRate = decided > 0 ? wrong / decided : 0;
  const missedPerNotice = missed / plans.length;
  const coverageRatio = currentTotal > 0 ? correct / currentTotal : Number.POSITIVE_INFINITY;
  const costPerNotice = costs.length > 0
    ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length
    : 0;
  const structuredRatio = correct > 0 ? structured / correct : 0;
  const gates = [
    {
      id: "strict_precision",
      threshold: { operator: "gte", value: GATES.strictPrecisionMin },
      actual: strictPrecision,
      pass: strictPrecision >= GATES.strictPrecisionMin,
    },
    {
      id: "wrong_rate",
      threshold: { operator: "lte", value: GATES.wrongRateMax },
      actual: wrongRate,
      pass: wrongRate <= GATES.wrongRateMax,
    },
    {
      id: "missed_per_notice",
      threshold: { operator: "lte", value: GATES.missedPerNoticeMax },
      actual: missedPerNotice,
      pass: missedPerNotice <= GATES.missedPerNoticeMax,
    },
    {
      id: "coverage_ratio",
      threshold: { operator: "gte", value: GATES.coverageRatioMin },
      actual: Number.isFinite(coverageRatio) ? coverageRatio : null,
      pass: coverageRatio >= GATES.coverageRatioMin,
    },
    {
      id: "cost_per_notice_usd",
      threshold: { operator: "lte", value: GATES.costPerNoticeMaxUsd },
      actual: costPerNotice,
      pass: costPerNotice <= GATES.costPerNoticeMaxUsd,
    },
    {
      id: "structured_ratio",
      threshold: { operator: "gte", value: GATES.structuredRatioMin },
      actual: structuredRatio,
      pass: structuredRatio >= GATES.structuredRatioMin,
    },
  ];
  const sourceDrift: string[] = [];
  for (const source of manifest.sourceArtifacts) {
    const verified = await verifyPromotionSourceArtifact(source);
    for (const changed of verified.changed) sourceDrift.push(`${source.grantId}:${changed}`);
  }
  const go = gates.every((gate) => gate.pass) && sourceDrift.length === 0;
  const artifact = {
    schema: "analysis-lab-promotion-aggregate-v1",
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    createdAt: new Date().toISOString(),
    noticeCount: plans.length,
    totals: { correct, needsEdit, wrong, unsure, missed, currentTotal, structured },
    gates,
    sourceDrift,
    verdict: go ? "GO" : gates.filter((gate) => gate.pass).length >= 5 ? "ITERATE" : "STOP",
  };
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(releaseId, "aggregate.json"),
    artifact,
  );
  console.log(
    `[aggregate] release ${artifact.verdict}: ${releaseId} · ` +
    `gate ${gates.filter((gate) => gate.pass).length}/${gates.length} · source drift ${sourceDrift.length}`,
  );
  if (!go) process.exitCode = 2;
}

// 콘솔 표 정렬용 전각(2칸) 문자 범위 — 한글 자모·CJK 통합/호환·한글 음절·전각 기호.
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

/** 콘솔 표 정렬용 표시 폭 — 한글 등 전각 문자는 2칸으로 센다. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1;
  return width;
}

function padCell(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 공고(런) 1건의 검수 집계 조각 — 전역 합산과 층별 분해 표가 같은 값을 공유한다. */
interface NoticeStats {
  run: LabRun;
  review: LabReview;
  stratum: string;
  /** 검수 주체(§9) — 사람 전수 검수면 null, 감사 확정 AI 검수면 provenance. */
  auditProvenance: AuditedReviewProvenance | null;
  correct: number;
  needsEdit: number;
  wrong: number;
  unsure: number;
  confirmedAbsent: number;
  missed: number;
  /** 현행 DB(A) criterion 수. */
  current: number;
  /** 현행 A 중 구조화(operator≠text_only). */
  currentMachine: number;
  /** 정확 확정 B 중 구조화(operator≠text_only). */
  correctStructured: number;
}

function computeNoticeStats(
  { run, review }: ReviewedRun,
  stratum: string,
  auditProvenance: AuditedReviewProvenance | null,
): NoticeStats {
  const verdicts = { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 };
  for (const item of review.criterionReviews) verdicts[item.verdict] += 1;
  const axis = { confirmed_absent: 0, missed_condition: 0 };
  for (const item of review.axisReviews) axis[item.verdict] += 1;
  const current = run.dimensionDiffs.reduce((sum, diff) => sum + diff.current.length, 0);
  const currentMachine = run.dimensionDiffs.reduce(
    (sum, diff) => sum + diff.current.filter((item) => item.operator !== "text_only").length,
    0,
  );
  let correctStructured = 0;
  for (const item of review.criterionReviews) {
    if (item.verdict !== "correct") continue;
    const criterion = run.criteria[item.criterionIndex];
    if (criterion && criterion.operator !== "text_only") correctStructured += 1;
  }
  return {
    run,
    review,
    stratum,
    auditProvenance,
    correct: verdicts.correct,
    needsEdit: verdicts.needs_edit,
    wrong: verdicts.wrong,
    unsure: verdicts.unsure,
    confirmedAbsent: axis.confirmed_absent,
    missed: axis.missed_condition,
    current,
    currentMachine,
    correctStructured,
  };
}

// ── 위치 진단(선행 구현 #7 — 진단 전용·게이트 아님) ─────────────────
// 제안 criterion 의 근거 위치(spanOffsetRatio — extractor 가 span 검증 시점에 기록)를
// 전/중/후 3분위로 분해해 단일 패스의 장문 recall 저하(lost-in-the-middle)를 관찰한다:
// 후반부 제안 밀도 급감 = recall 저하 신호. 누락(missed_condition)의 원문 내 위치는
// 런에 입력 원문이 저장되지 않아(inputSha256·inputTotalChars 만) 사후 계산이 원리적으로
// 불가 — 건수만 "위치 미상"으로 병기한다. 구 런(파일럿)은 필드가 없어 전량 미계측.

/** lost-in-the-middle 진단의 핵심 구간 — 이 길이 이상 입력 공고를 별도 줄로 분해한다. */
const LONG_INPUT_MIN_CHARS = 30_000;

/** spanOffsetRatio(0~1)의 전(0~⅓)/중(⅓~⅔)/후(⅔~1) 버킷 인덱스. */
function positionBucket(ratio: number): 0 | 1 | 2 {
  if (ratio < 1 / 3) return 0;
  if (ratio < 2 / 3) return 1;
  return 2;
}

/** 그룹의 버킷별 "제안 수(검수 정확 수)" 1줄 — 미계측(필드 없음/null)은 건수 병기. */
function positionLine(label: string, group: NoticeStats[]): string {
  const proposed: [number, number, number] = [0, 0, 0];
  const correctByBucket: [number, number, number] = [0, 0, 0];
  let unmeasured = 0;
  for (const item of group) {
    const correctIndexes = new Set(
      item.review.criterionReviews
        .filter((review) => review.verdict === "correct")
        .map((review) => review.criterionIndex),
    );
    for (const [index, criterion] of item.run.criteria.entries()) {
      const ratio = criterion.spanOffsetRatio;
      if (typeof ratio !== "number") {
        unmeasured += 1; // 구 런(파일럿) 또는 미검증 span — 위치 정보 없음.
        continue;
      }
      const bucket = positionBucket(ratio);
      proposed[bucket] += 1;
      if (correctIndexes.has(index)) correctByBucket[bucket] += 1;
    }
  }
  const cells = ["전(0~⅓)", "중(⅓~⅔)", "후(⅔~1)"]
    .map((name, i) => `${name} ${proposed[i] ?? 0}건(정확 ${correctByBucket[i] ?? 0})`)
    .join(" · ");
  return `  ${label}: ${cells} · 미계측 ${unmeasured}건`;
}

function printPositionDiagnostics(stats: NoticeStats[], missed: number): void {
  console.log("===== 위치 진단 (진단 전용 — 게이트 아님) =====");
  console.log(positionLine(`제안 근거 위치 — 전체 공고 ${stats.length}건`, stats));
  const longInput = stats.filter((item) => item.run.inputTotalChars >= LONG_INPUT_MIN_CHARS);
  if (longInput.length > 0) {
    console.log(positionLine(`입력 ${LONG_INPUT_MIN_CHARS.toLocaleString("en-US")}자 이상 ${longInput.length}건`, longInput));
  } else {
    console.log(
      `  입력 ${LONG_INPUT_MIN_CHARS.toLocaleString("en-US")}자 이상 공고 없음 — lost-in-the-middle 핵심 구간 미표집`,
    );
  }
  console.log(`  누락(missed_condition) ${missed}건 — 위치 미상(런에 원문 비저장·사후 계산 불가)`);
  console.log("");
}

/**
 * 층별 분해 표(진단용) — 코호트 entries 의 stratum 을 grantId 로 조인해 층별 요약을
 * 정렬 표로 출력한다. 게이트 판정은 전역 집계로만 하며 층별 수치는 판정에 쓰지 않는다.
 * 코호트에 있으나 검수가 없는 층도 진행률(0/N)로 드러낸다. "(코호트 외)"는 --all 전용.
 */
function printStratumTable(stats: NoticeStats[], cohort: CohortFileV2): void {
  const order: string[] = [];
  const cohortTotals = new Map<string, number>();
  for (const entry of cohort.entries) {
    if (!cohortTotals.has(entry.stratum)) order.push(entry.stratum);
    cohortTotals.set(entry.stratum, (cohortTotals.get(entry.stratum) ?? 0) + 1);
  }
  if (stats.some((item) => item.stratum === OUTSIDE_STRATUM)) order.push(OUTSIDE_STRATUM);

  const header = ["층", "공고", "판정", "정확", "오류", "누락", "구조화", "평균비용"];
  const rows: string[][] = [header];
  for (const stratum of order) {
    const group = stats.filter((item) => item.stratum === stratum);
    const cohortTotal = cohortTotals.get(stratum);
    const decided = group.reduce(
      (sum, item) => sum + item.correct + item.needsEdit + item.wrong + item.unsure,
      0,
    );
    const correct = group.reduce((sum, item) => sum + item.correct, 0);
    const wrong = group.reduce((sum, item) => sum + item.wrong, 0);
    const missed = group.reduce((sum, item) => sum + item.missed, 0);
    const structured = group.reduce((sum, item) => sum + item.correctStructured, 0);
    const costs = group
      .map((item) => item.run.costUsd)
      .filter((cost): cost is number => cost !== null);
    rows.push([
      stratum,
      cohortTotal !== undefined ? `${group.length}/${cohortTotal}` : `${group.length}`,
      `${decided}`,
      decided > 0 ? `${correct}(${pct(correct / decided)})` : "—",
      `${wrong}`,
      `${missed}`,
      correct > 0 ? pct(structured / correct) : "—",
      costs.length > 0 ? `$${(costs.reduce((sum, cost) => sum + cost, 0) / costs.length).toFixed(3)}` : "—",
    ]);
  }

  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => displayWidth(row[column] ?? ""))),
  );
  console.log("===== 층별 분해 (진단용 — 게이트 판정은 전역 집계로만) =====");
  for (const [index, row] of rows.entries()) {
    console.log(`  ${row.map((cell, column) => padCell(cell, widths[column] ?? 0)).join("  ")}`);
    if (index === 0) {
      console.log(`  ${widths.map((width) => "-".repeat(width)).join("  ")}`);
    }
  }
  console.log("");
}

async function main() {
  const releaseId = readArg("release")?.trim();
  if (releaseId) {
    await aggregateRelease(releaseId);
    return;
  }
  const args = new Set(process.argv.slice(2));
  const scanAll = args.has("--all");
  const verbose = args.has("--verbose");

  // 코호트 필터(기본) — cohort.json 의 공고만 집계해 다른 실험 검수의 혼입을 막고,
  // 검수 보존 가드로 코호트 안에 남은 파일럿 층은 게이트 판정 표본에서 제외한다(파일
  // 상단 주석 — 확대 계획 §3 사전 등록). 수집·필터·dedupe 는 reviewed-runs.ts 공유 모듈.
  const { cohort, stratumByGrant, pool, reviewed } = await selectReviewedRuns({
    scanAll,
    excludePilotStratum: true,
  });

  // §9: 사람 review.json 없는 공고의 "AI 검수 + 완료된 사람 감사" 확정분을 게이트 표본에
  // 편입한다. 같은 공고에 사람 검수가 있으면 사람 검수 우선(감사 확정분 제외 + 경고).
  const audited = await loadAuditedConfirmedReviews({
    model: AI_REVIEW_ADOPTED.model,
    scanAll,
    excludePilotStratum: true,
  });
  const humanGrantIds = new Set(reviewed.map((item) => item.run.grantId));
  const auditedConfirmed = audited.confirmed.filter((item) => {
    if (!humanGrantIds.has(item.run.grantId)) return true;
    console.warn(
      `[경고] 사람 검수 보유 공고의 감사 확정분 제외(사람 검수 우선): ${item.run.source}/${item.run.sourceId}`,
    );
    return false;
  });

  // 방법론 병기(§9 게이트 해석 조항) — 검수 주체와 캘리브레이션 측정오차를 항상 드러낸다.
  // §9 완화 개정: 감사 항목의 확정 주체(사람 vs AI 블라인드 일치 자동확정)도 병기한다.
  const humanAuditedItems = auditedConfirmed.reduce((sum, item) => sum + item.provenance.auditedCount, 0);
  const aiConcurItems = auditedConfirmed.reduce((sum, item) => sum + item.provenance.aiConcurCount, 0);
  const auditBreakdown =
    aiConcurItems > 0 ? ` · 감사 항목: 사람 ${humanAuditedItems} + AI 블라인드 일치 자동확정 ${aiConcurItems}` : "";
  const methodologyLine =
    `검수 방법론: 사람 전수 ${reviewed.length}건 + AI(${AI_REVIEW_ADOPTED.model}·${AI_REVIEW_ADOPTED.promptVersion})+감사 ${auditedConfirmed.length}건(§9)` +
    ` · 캘리브레이션 일치 criterion ${AI_REVIEW_ADOPTED.calibration.criterionAgreement}·빈 축 ${AI_REVIEW_ADOPTED.calibration.emptyAxisAgreement}` +
    auditBreakdown;
  const pendingLine =
    audited.pending.length > 0
      ? `[안내] 감사 대기 ${audited.pending.length}건 — 게이트 표본 제외(감사 완료 시 편입). 감사 시트: /dev/analysis-lab 런 상세 "감사" 탭.`
      : null;

  if (reviewed.length + auditedConfirmed.length === 0) {
    console.log(methodologyLine);
    if (pendingLine) console.log(pendingLine);
    console.log("검수된 런이 없습니다 — 검수 탭에서 판정 후 '검수 저장'을 눌러주세요.");
    process.exitCode = 1;
    return;
  }

  const excluded = pool.length - reviewed.length;
  const scopeLabel = scanAll
    ? "전수(--all)"
    : cohort
      ? `코호트 ${cohort.experimentLabel ?? "(라벨 없음)"} ${cohort.entries.length}건 중`
      : "전수(cohort.json 없음)";
  console.log(
    `===== 검수 집계 — ${scopeLabel} 공고 ${reviewed.length + auditedConfirmed.length}건${excluded > 0 ? ` · 검수 ${excluded}건 제외` : ""} =====`,
  );
  console.log(methodologyLine);
  if (pendingLine) console.log(pendingLine);
  console.log("");

  const stats = [
    ...reviewed.map((item) =>
      computeNoticeStats(item, stratumByGrant.get(item.run.grantId) ?? OUTSIDE_STRATUM, null),
    ),
    ...auditedConfirmed.map((item) =>
      computeNoticeStats(
        { run: item.run, review: item.review },
        stratumByGrant.get(item.run.grantId) ?? OUTSIDE_STRATUM,
        item.provenance,
      ),
    ),
  ];

  for (const item of stats) {
    const { run, review } = item;
    const decidedC = review.criterionReviews.length;
    // 기본은 공고당 1줄 요약(30~100건 스케일 대비) — criterion 사유·누락·메모는 --verbose.
    // 감사 확정 AI 검수는 검수 주체 마커를 병기한다(§9 — 방법론 은폐 금지).
    const auditTag = item.auditProvenance
      ? ` [AI+감사(뒤집힘 ${item.auditProvenance.overturnedCount}${
          item.auditProvenance.aiConcurCount > 0 ? `·AI일치 ${item.auditProvenance.aiConcurCount}` : ""
        })]`
      : "";
    console.log(
      `[${run.source}/${run.sourceId}] ${run.title.slice(0, 46)} — criterion ${decidedC}/${run.criteria.length}` +
        ` · 정확 ${item.correct} · 수정 ${item.needsEdit} · 오류 ${item.wrong} · 판단불가 ${item.unsure}` +
        ` · 누락 ${item.missed} · B구조화 ${item.correctStructured}/${item.correct}${auditTag}`,
    );
    if (!verbose) continue;
    console.log(
      `  빈 축 ${review.axisReviews.length} 확인 — 없음 ${item.confirmedAbsent} · 누락 ${item.missed}` +
        ` | 현행 A ${item.current}건(구조화 ${item.currentMachine}) · 층 ${item.stratum} · 검수자 ${review.reviewerEmail}`,
    );
    for (const criterionReview of review.criterionReviews) {
      if (criterionReview.verdict === "correct") continue;
      const criterion = run.criteria[criterionReview.criterionIndex];
      const tag = criterion
        ? `${criterion.dimension}/${criterion.kind}`
        : `#${criterionReview.criterionIndex}`;
      console.log(
        `    - [${criterionReview.verdict}] ${tag}: ${(criterionReview.note ?? "(사유 없음)").slice(0, 100)}`,
      );
    }
    for (const axisReview of review.axisReviews) {
      if (axisReview.verdict !== "missed_condition") continue;
      console.log(`    - [누락] ${axisReview.dimension}: ${(axisReview.note ?? "").slice(0, 100)}`);
    }
    if (review.overallNote) console.log(`    메모: ${review.overallNote.slice(0, 140)}`);
    console.log("");
  }
  if (!verbose) console.log("");

  const correct = stats.reduce((sum, item) => sum + item.correct, 0);
  const needsEdit = stats.reduce((sum, item) => sum + item.needsEdit, 0);
  const wrong = stats.reduce((sum, item) => sum + item.wrong, 0);
  const unsure = stats.reduce((sum, item) => sum + item.unsure, 0);
  const confirmedAbsent = stats.reduce((sum, item) => sum + item.confirmedAbsent, 0);
  const missed = stats.reduce((sum, item) => sum + item.missed, 0);
  const currentTotal = stats.reduce((sum, item) => sum + item.current, 0);
  // 기계판정 가능(구조화, operator≠text_only) — A 는 현행 DB 전체, B 는 "정확" 확정분만.
  const machineA = stats.reduce((sum, item) => sum + item.currentMachine, 0);
  const machineB = stats.reduce((sum, item) => sum + item.correctStructured, 0);
  const costs = stats
    .map((item) => item.run.costUsd)
    .filter((cost): cost is number => cost !== null);
  const costTotal = costs.reduce((sum, cost) => sum + cost, 0);

  const decided = correct + needsEdit + wrong + unsure;
  const strictPrecision = decided > 0 ? correct / decided : 0;
  const tolerantPrecision = decided > 0 ? (correct + needsEdit) / decided : 0;
  const wrongRate = decided > 0 ? wrong / decided : 0;
  // 분모는 게이트 표본 전체(사람 전수 + 감사 확정 AI 검수) 공고 수.
  const missedPerNotice = missed / stats.length;
  const coverageRatio = currentTotal > 0 ? correct / currentTotal : Number.POSITIVE_INFINITY;
  const costPerNotice = costs.length > 0 ? costTotal / costs.length : 0;
  // 구조화 비율 게이트 — 정확 확정 B 중 구조화. 승격 근거는 contract.ts GATES 주석 참조.
  const structuredRatio = correct > 0 ? machineB / correct : 0;

  console.log("===== 종합 =====");
  console.log(
    `criterion 판정 ${decided}건 — 정확 ${correct}(${pct(strictPrecision)}, ${ciText(correct, decided)})` +
      ` · 수정 ${needsEdit} · 오류 ${wrong}(${pct(wrongRate)}) · 판단불가 ${unsure} · 관용 정밀도(정확+수정) ${pct(tolerantPrecision)}`,
  );
  console.log(
    `빈 축 확인 ${confirmedAbsent + missed}건 — 없음 확인 ${confirmedAbsent} · 누락 ${missed} (공고당 평균 ${missedPerNotice.toFixed(2)}건)`,
  );
  console.log(
    `커버리지 — 사람 확정(correct) B ${correct}건 vs 현행 A ${currentTotal}건 = ${currentTotal > 0 ? `${coverageRatio.toFixed(2)}x` : "A 0건(비교 불가·무한대)"}`,
  );
  console.log(
    `구조화 비율(게이트) — 정확 확정 B 중 구조화 ${machineB}/${correct}건` +
      `(${correct > 0 ? `${pct(structuredRatio)}, ${ciText(machineB, correct)}` : "—"})` +
      ` | A→B 배수(관찰 지표·게이트 아님): 현행 A ${machineA}건 → B ${machineB}건` +
      `${machineA > 0 ? ` = ${(machineB / machineA).toFixed(2)}x` : " (A 0건·비교 불가)"}`,
  );
  console.log(`비용 — 공고당 평균 $${costPerNotice.toFixed(3)}\n`);

  printPositionDiagnostics(stats, missed);

  if (cohort) printStratumTable(stats, cohort);

  const gates = [
    {
      pass: strictPrecision >= GATES.strictPrecisionMin,
      line: gateLine(
        "정밀도(엄격, correct 비율)",
        pct(strictPrecision),
        `≥ ${pct(GATES.strictPrecisionMin)}`,
        strictPrecision >= GATES.strictPrecisionMin,
      ),
    },
    {
      pass: wrongRate <= GATES.wrongRateMax,
      line: gateLine("치명 오류율(wrong)", pct(wrongRate), `≤ ${pct(GATES.wrongRateMax)}`, wrongRate <= GATES.wrongRateMax),
    },
    {
      pass: missedPerNotice <= GATES.missedPerNoticeMax,
      line: gateLine(
        "재현율(공고당 누락)",
        `${missedPerNotice.toFixed(2)}건`,
        `≤ ${GATES.missedPerNoticeMax}건`,
        missedPerNotice <= GATES.missedPerNoticeMax,
      ),
    },
    {
      pass: coverageRatio >= GATES.coverageRatioMin,
      line: gateLine(
        "커버리지(확정 B / 현행 A)",
        currentTotal > 0 ? `${coverageRatio.toFixed(2)}x` : "∞(A 0건)",
        `≥ ${GATES.coverageRatioMin}x`,
        coverageRatio >= GATES.coverageRatioMin,
      ),
    },
    {
      pass: costPerNotice <= GATES.costPerNoticeMaxUsd,
      line: gateLine(
        "비용(공고당)",
        `$${costPerNotice.toFixed(3)}`,
        `≤ $${GATES.costPerNoticeMaxUsd}`,
        costPerNotice <= GATES.costPerNoticeMaxUsd,
      ),
    },
    {
      pass: structuredRatio >= GATES.structuredRatioMin,
      line: gateLine(
        "구조화 비율(정확 확정 B 중 operator≠text_only)",
        correct > 0 ? pct(structuredRatio) : "—(정확 0건)",
        `≥ ${pct(GATES.structuredRatioMin)}`,
        structuredRatio >= GATES.structuredRatioMin,
      ),
    },
  ];

  console.log("===== 통과 기준 판정 =====");
  for (const gate of gates) console.log(gate.line);
  const passed = gates.filter((gate) => gate.pass).length;
  // 종합 판정은 게이트 수에 자동 연동(하드코딩 금지) — 게이트 추가 시 그대로 반영된다.
  const verdict =
    passed === gates.length ? "🟢 통과" : passed >= gates.length - 1 ? "🟡 조건부 통과" : "🔴 미달";
  console.log(`\n종합 판정: ${verdict} (${passed}/${gates.length})`);
  console.log(
    "주의: 게이트 판정은 점추정이다 — 병기된 Wilson 95% CI 로 표본 크기를 감안해 읽을 것. 신뢰한계 기반 판정 도입 여부는 확대 실험 판정 문서에서 결정한다.",
  );
}

void main();

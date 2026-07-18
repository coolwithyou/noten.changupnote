// 공모 딥분석 실험실 — 검수 집계·통과 기준 판정 CLI (dev 전용, DB·네트워크 미사용).
// spike-out/analysis-lab/ 의 <runId>.review.json 을 전수 스캔해 런과 짝짓고,
// 정밀도(criterion 판정)·재현율(빈 축 누락)·커버리지(확정 B vs 현행 A)·비용을 집계한 뒤
// 스파이크 통과 기준(GATES)에 대해 자동 판정한다.
// 실행: pnpm lab:aggregate
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ANALYSIS_LAB_GATES as GATES,
  type LabReview,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { analysisLabDir } from "./run-store";

interface ReviewedRun {
  run: LabRun;
  review: LabReview;
}

async function collect(): Promise<ReviewedRun[]> {
  const root = analysisLabDir();
  const reviewed: ReviewedRun[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue;
    let files: string[] = [];
    try {
      files = await readdir(join(root, entry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".review.json")) continue;
      try {
        const review = JSON.parse(
          await readFile(join(root, entry, file), "utf8"),
        ) as LabReview;
        const run = JSON.parse(
          await readFile(join(root, entry, file.replace(/\.review\.json$/, ".json")), "utf8"),
        ) as LabRun;
        reviewed.push({ run, review });
      } catch {
        console.warn(`[경고] 검수/런 파일 파싱 실패 — 건너뜀: ${entry}/${file}`);
      }
    }
  }
  return reviewed;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function gateLine(name: string, actual: string, target: string, pass: boolean): string {
  return `  ${pass ? "✅ 통과" : "❌ 미달"} | ${name}: ${actual} (기준 ${target})`;
}

/**
 * 집계 대상 정제 — 실패 런의 검수는 제외하고, 같은 공고(grantId)에 검수가 여러 개면
 * 최신(updatedAt) 1건만 남긴다. "공고당" 지표(누락·커버리지)의 분모를 공고 수와
 * 일치시키기 위함이며, 제외분은 침묵하지 않고 경고로 드러낸다.
 */
function dedupe(all: ReviewedRun[]): ReviewedRun[] {
  const byGrant = new Map<string, ReviewedRun>();
  for (const item of all) {
    if (item.run.error !== null) {
      console.warn(
        `[경고] 실패 런의 검수는 집계에서 제외: ${item.run.source}/${item.run.sourceId} ${item.run.runId}`,
      );
      continue;
    }
    const previous = byGrant.get(item.run.grantId);
    if (!previous) {
      byGrant.set(item.run.grantId, item);
      continue;
    }
    const [kept, droppedItem] =
      previous.review.updatedAt >= item.review.updatedAt ? [previous, item] : [item, previous];
    byGrant.set(kept.run.grantId, kept);
    console.warn(
      `[경고] 같은 공고의 검수 ${droppedItem.run.runId} 제외 — 공고당 최신 검수 1건(${kept.run.runId})만 집계`,
    );
  }
  return [...byGrant.values()];
}

async function main() {
  const all = await collect();
  const reviewed = dedupe(all);
  if (reviewed.length === 0) {
    console.log("검수된 런이 없습니다 — 검수 탭에서 판정 후 '검수 저장'을 눌러주세요.");
    process.exitCode = 1;
    return;
  }

  const excluded = all.length - reviewed.length;
  console.log(
    `===== 검수 집계 (공고 ${reviewed.length}건${excluded > 0 ? ` · 검수 ${excluded}건 제외` : ""}) =====\n`,
  );

  let correct = 0;
  let needsEdit = 0;
  let wrong = 0;
  let unsure = 0;
  let confirmedAbsent = 0;
  let missed = 0;
  let currentTotal = 0;
  let costTotal = 0;
  let costCount = 0;

  for (const { run, review } of reviewed) {
    const verdicts = { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 };
    for (const item of review.criterionReviews) verdicts[item.verdict] += 1;
    const axis = { confirmed_absent: 0, missed_condition: 0 };
    for (const item of review.axisReviews) axis[item.verdict] += 1;
    const current = run.dimensionDiffs.reduce((sum, diff) => sum + diff.current.length, 0);

    correct += verdicts.correct;
    needsEdit += verdicts.needs_edit;
    wrong += verdicts.wrong;
    unsure += verdicts.unsure;
    confirmedAbsent += axis.confirmed_absent;
    missed += axis.missed_condition;
    currentTotal += current;
    if (run.costUsd !== null) {
      costTotal += run.costUsd;
      costCount += 1;
    }

    const decidedC = review.criterionReviews.length;
    console.log(`[${run.source}/${run.sourceId}] ${run.title.slice(0, 46)}`);
    console.log(
      `  criterion ${decidedC}/${run.criteria.length} 판정 — 정확 ${verdicts.correct} · 수정 ${verdicts.needs_edit} · 오류 ${verdicts.wrong} · 판단불가 ${verdicts.unsure}` +
        ` | 빈 축 ${review.axisReviews.length} 확인 — 없음 ${axis.confirmed_absent} · 누락 ${axis.missed_condition}` +
        ` | 현행 A ${current}건 · 검수자 ${review.reviewerEmail}`,
    );
    for (const item of review.criterionReviews) {
      if (item.verdict === "correct") continue;
      const criterion = run.criteria[item.criterionIndex];
      const tag = criterion ? `${criterion.dimension}/${criterion.kind}` : `#${item.criterionIndex}`;
      console.log(`    - [${item.verdict}] ${tag}: ${(item.note ?? "(사유 없음)").slice(0, 100)}`);
    }
    for (const item of review.axisReviews) {
      if (item.verdict !== "missed_condition") continue;
      console.log(`    - [누락] ${item.dimension}: ${(item.note ?? "").slice(0, 100)}`);
    }
    if (review.overallNote) console.log(`    메모: ${review.overallNote.slice(0, 140)}`);
    console.log("");
  }

  const decided = correct + needsEdit + wrong + unsure;
  const strictPrecision = decided > 0 ? correct / decided : 0;
  const tolerantPrecision = decided > 0 ? (correct + needsEdit) / decided : 0;
  const wrongRate = decided > 0 ? wrong / decided : 0;
  const missedPerNotice = missed / reviewed.length;
  const coverageRatio = currentTotal > 0 ? correct / currentTotal : Number.POSITIVE_INFINITY;
  const costPerNotice = costCount > 0 ? costTotal / costCount : 0;

  console.log("===== 종합 =====");
  console.log(
    `criterion 판정 ${decided}건 — 정확 ${correct}(${pct(strictPrecision)}) · 수정 ${needsEdit} · 오류 ${wrong}(${pct(wrongRate)}) · 판단불가 ${unsure} · 관용 정밀도(정확+수정) ${pct(tolerantPrecision)}`,
  );
  console.log(
    `빈 축 확인 ${confirmedAbsent + missed}건 — 없음 확인 ${confirmedAbsent} · 누락 ${missed} (공고당 평균 ${missedPerNotice.toFixed(2)}건)`,
  );
  console.log(
    `커버리지 — 사람 확정(correct) B ${correct}건 vs 현행 A ${currentTotal}건 = ${currentTotal > 0 ? `${coverageRatio.toFixed(2)}x` : "A 0건(비교 불가·무한대)"}`,
  );
  console.log(`비용 — 공고당 평균 $${costPerNotice.toFixed(3)}\n`);

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
  ];

  console.log("===== 통과 기준 판정 =====");
  for (const gate of gates) console.log(gate.line);
  const passed = gates.filter((gate) => gate.pass).length;
  const verdict =
    passed === gates.length ? "🟢 통과" : passed >= gates.length - 1 ? "🟡 조건부 통과" : "🔴 미달";
  console.log(`\n종합 판정: ${verdict} (${passed}/${gates.length})`);
  console.log(
    "주의: 검수 표본이 작을수록 수치의 신뢰구간이 넓다 — 판정은 확대 실험(층화 30~100건)의 착수 근거이지 최종 결론이 아니다.",
  );
}

void main();

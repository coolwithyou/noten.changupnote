// 공모 딥분석 실험실 — AI 검수 CLI (tsx 단독 실행, dev 서버 불필요, DB read-only).
// 확대 실험 계획 §9: 검수 주체 "사람 전수" → "AI 전수(추출과 다른 모델) + 사람 표본 감사".
//
// 실행: pnpm lab:ai-review -- --calibrate --model=claude-sonnet-5
//         → 사람 review.json 보유 런(파일럿 3건)에 AI 검수를 돌리고 사람 vs AI 비교 리포트
//           (confusion matrix·§9 채택 기준 자동 판정·불일치 상세)를 출력한다.
//       pnpm lab:ai-review -- [--limit=10] [--dry-run] [--max-cost-usd=5] [--model=...]
//         → 기본 모드: cohort.json 코호트 중 "사람 검수 없는" ok 런(확대 배치)에 AI 검수 실행.
//           --dry-run 은 대상·예상 비용만 출력(API 호출 0).
//       pnpm lab:ai-review -- --audit-list --model=claude-sonnet-5
//         → AI 검수 파일에서 사람 감사 대상(비-correct 전수 + missed_condition 플래그 전수 +
//           correct 시드(42) 결정론 20%)을 산출해 콘솔 표 + audit/<stamp>.json 으로 저장.
//       공통: --force (기존 ai-review 파일 덮어쓰기)
// 주의: --dry-run 이 아니면 실제 Anthropic API 비용이 발생한다. 사람 review.json 은 절대
//       건드리지 않으며 새로 쓰는 파일은 <runId>.ai-review.<modelSlug>.json 과 audit/*.json 뿐이다.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  AI_REVIEW_PROMPT_VERSION,
  aiReviewFilePath,
  computeAiReviewCostUsd,
  modelSlug,
  resolveAiReviewModel,
  runAiReview,
} from "./ai-review";
import {
  AUDIT_SAMPLE_RATIO,
  AUDIT_SEED,
  CRITERION_VERDICT_ORDER,
  compareCalibration,
  judgeAdoption,
  selectAuditTargets,
  type RunComparisonInput,
} from "./ai-review-compare";
import { collectAiReviewsForAudit, toAiReviewForAudit } from "./audit-store";
import { readCohortFileV2, cohortFilePath } from "./cohort-file";
import { DIMENSION_LABELS } from "./diff";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { selectReviewedRuns } from "./reviewed-runs";
import { analysisLabDir } from "./run-store";

loadMonorepoEnv();

const DEFAULT_LIMIT = 10;
const CONCURRENCY = 2;
const DEFAULT_MAX_COST_USD = 5;
// 감사 표본 시드·비율은 ai-review-compare 의 AUDIT_SEED/AUDIT_SAMPLE_RATIO 가 단일 원천 —
// 감사 파일 생성(audit-store)과 같은 값을 써야 --audit-list 와 같은 대상이 나온다.

// ---- argv 파싱 (batch.ts 관행) ----------------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readNumberArg(name: string, fallback: number): number | null {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---- 콘솔 표 정렬(전각 2칸) — aggregate.ts 헬퍼 복제(그 파일은 CLI 라 import 불가) --

const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1;
  return width;
}

function padCell(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function shortTitle(title: string, max = 22): string {
  let width = 0;
  let out = "";
  for (const ch of title) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
    if (width > max) return `${out}…`;
    out += ch;
  }
  return out;
}

// ---- API 키 -----------------------------------------------------------------------

function requireApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 가 없습니다 — 모노레포 루트 .env(.env.local)를 확인하세요.");
  }
  return apiKey;
}

// ---- spike-out 스캔(기본 모드·감사 모드 공용) --------------------------------------

interface GrantRunScan {
  /** 현행 promptVersion 의 ok 런 중 최신 1건. */
  latestOkRun: LabRun | null;
  /** 이 공고의 어떤 런에든 사람 검수(review.json)가 있으면 true. */
  hasHumanReview: boolean;
}

async function scanRunDirs(): Promise<Map<string, GrantRunScan>> {
  const byGrant = new Map<string, GrantRunScan>();
  const root = analysisLabDir();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return byGrant;
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue;
    let files: string[] = [];
    try {
      files = await readdir(join(root, entry));
    } catch {
      continue;
    }
    const reviewedRunIds = new Set(
      files
        .filter((file) => file.endsWith(".review.json"))
        .map((file) => file.replace(/\.review\.json$/, "")),
    );
    for (const file of files) {
      if (!file.startsWith("run-") || !file.endsWith(".json")) continue;
      if (file.endsWith(".review.json") || file.includes(".ai-review.")) continue;
      let run: LabRun;
      try {
        run = JSON.parse(await readFile(join(root, entry, file), "utf8")) as LabRun;
      } catch {
        continue;
      }
      if (typeof run.grantId !== "string" || typeof run.runId !== "string") continue;
      const state = byGrant.get(run.grantId) ?? { latestOkRun: null, hasHumanReview: false };
      if (reviewedRunIds.has(run.runId)) state.hasHumanReview = true;
      if (run.error === null && run.promptVersion === ANALYSIS_LAB_PROMPT_VERSION) {
        if (!state.latestOkRun || run.startedAt > state.latestOkRun.startedAt) state.latestOkRun = run;
      }
      byGrant.set(run.grantId, state);
    }
  }
  return byGrant;
}

/** 리뷰 비용 추정 — 추출 런의 입력 토큰 + rubric·criteria 오버헤드(~8K) + 출력 ~3K 토큰. */
function estimateReviewCostUsd(model: string, run: LabRun): number | null {
  const inputTokens = (run.usage?.inputTokens ?? Math.round(run.inputTotalChars / 2)) + 8_000;
  return computeAiReviewCostUsd(model, { inputTokens, outputTokens: 3_000, cacheReadTokens: null });
}

// ---- 캘리브레이션 모드 -------------------------------------------------------------

async function runCalibrateMode(model: string, force: boolean): Promise<number> {
  const apiKey = requireApiKey();
  console.log(`[calibrate] 판정 모델: ${model} · promptVersion=${AI_REVIEW_PROMPT_VERSION}`);

  // 대상 = 사람 review.json 보유 런 전수(파일럿 3건) — reviewed-runs 공유 모듈의 전수 스캔.
  const selection = await selectReviewedRuns({ scanAll: true });
  const targets = selection.reviewed;
  if (targets.length === 0) {
    console.error("[calibrate] 사람 검수 런이 없습니다 — 캘리브레이션 불가.");
    return 1;
  }
  console.log(`[calibrate] 사람 검수 런 ${targets.length}건 대상`);

  const comparisons: RunComparisonInput[] = [];
  const failures: string[] = [];
  let totalCostUsd = 0;

  for (const target of targets) {
    const label = `${target.run.source}/${target.run.sourceId} ${shortTitle(target.run.title)}`;
    try {
      const outcome = await runAiReview({ run: target.run, model, apiKey, force });
      if (outcome.status === "input_drift") {
        failures.push(
          `${label}: 원문 드리프트 — 재조립 sha ${outcome.actualSha256.slice(0, 12)}… ≠ 런 sha ${outcome.expectedSha256.slice(0, 12)}… (검수 불가·스킵)`,
        );
        continue;
      }
      if (outcome.status === "refusal") {
        failures.push(`${label}: 모델이 판정을 거부(stop_reason=refusal) — 판정 실패로 기록.`);
        continue;
      }
      const file = outcome.file;
      if (outcome.status === "created") {
        totalCostUsd += file.costUsd ?? 0;
        console.log(
          `[calibrate] AI 검수 생성: ${label} · ${(file.durationMs / 1000).toFixed(1)}s · $${(file.costUsd ?? 0).toFixed(4)}`,
        );
      } else {
        console.log(`[calibrate] 기존 AI 검수 재사용: ${label} (${file.createdAt})`);
      }
      comparisons.push({
        grantId: target.run.grantId,
        runId: target.run.runId,
        title: target.run.title,
        humanCriterionReviews: target.review.criterionReviews,
        humanAxisReviews: target.review.axisReviews,
        aiCriterionReviews: file.criterionReviews,
        aiAxisReviews: file.axisReviews,
      });
    } catch (caught) {
      failures.push(`${label}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  if (failures.length > 0) {
    console.log("\n[calibrate] 실패·스킵:");
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  if (comparisons.length === 0) {
    console.error("\n[calibrate] 비교 가능한 런이 없습니다 — 종료.");
    return 1;
  }

  printCalibrationReport(model, comparisons, totalCostUsd);
  return 0;
}

function printCalibrationReport(model: string, comparisons: RunComparisonInput[], totalCostUsd: number): void {
  const report = compareCalibration(comparisons);

  console.log(`\n===== 캘리브레이션 리포트 (사람 골든 vs AI · 모델 ${model}) =====`);
  console.log(`비교 런 ${comparisons.length}건 · 이번 실행 API 비용 $${totalCostUsd.toFixed(4)}`);

  // criterion confusion matrix — 행: 사람, 열: AI.
  const header = ["사람\\AI", ...CRITERION_VERDICT_ORDER];
  const colWidths = header.map((cell) => Math.max(displayWidth(cell) + 2, 12));
  console.log("\n[criterion verdict confusion matrix]");
  console.log(header.map((cell, i) => padCell(cell, colWidths[i]!)).join(""));
  CRITERION_VERDICT_ORDER.forEach((humanVerdict, rowIndex) => {
    const cells = [
      humanVerdict,
      ...report.confusion[rowIndex]!.map((count) => String(count)),
    ];
    console.log(cells.map((cell, i) => padCell(cell, colWidths[i]!)).join(""));
  });
  console.log(`정확 일치: ${report.exactMatches}/${report.criterionTotal}`);
  console.log(`사람 correct → AI wrong 오검출: ${report.correctToWrong}건`);
  if (report.humanOnlyCriterionCount > 0) {
    console.log(`⚠️ 사람만 판정한 criterion ${report.humanOnlyCriterionCount}건(AI 커버리지 결함) — 분모에서 제외됨`);
  }

  console.log(
    `\n[빈 축] 사람 confirmed_absent 일치: ${report.axisAgreement}/${report.axisHumanConfirmedTotal}`,
  );
  if (report.axisMismatches.length > 0) {
    console.log("빈 축 불일치(사람 없음 확인 vs AI):");
    for (const mismatch of report.axisMismatches) {
      console.log(
        `  - (${shortTitle(mismatch.title)}) ${mismatch.dimension}(${DIMENSION_LABELS[mismatch.dimension]}): ` +
          `AI ${mismatch.aiVerdict ?? "미판정"}${mismatch.aiNote ? ` — ${mismatch.aiNote}` : ""}`,
      );
    }
  }
  if (report.humanMissedAxes.length > 0) {
    console.log(`사람 missed_condition 축 ${report.humanMissedAxes.length}건(§9 분모 밖 — 참고):`);
    for (const item of report.humanMissedAxes) {
      console.log(`  - ${item.dimension}: AI ${item.aiVerdict ?? "미판정"}`);
    }
  }
  if (report.extraMissedFlags.length > 0) {
    console.log("\n[AI 추가 missed_condition 플래그 — 실격 아님, 사람 미확인 후보로 표기]");
    for (const flag of report.extraMissedFlags) {
      console.log(
        `  - (${shortTitle(flag.title)}) ${flag.dimension}(${DIMENSION_LABELS[flag.dimension]}): ${flag.aiNote ?? "(note 없음)"}`,
      );
    }
  } else {
    console.log("\n[AI 추가 missed_condition 플래그] 없음");
  }

  // §9 사전 등록 채택 기준 자동 판정.
  const judgment = judgeAdoption(report);
  console.log(`\n[§9 사전 등록 채택 기준 자동 판정 — 모델 ${model}]`);
  for (const line of judgment.lines) {
    console.log(`  ${line.pass ? "✅ 충족" : "❌ 미달"} | ${line.name}: ${line.actual} (기준 ${line.target})`);
  }
  if (judgment.totalsWarning) console.log(`  ⚠️ ${judgment.totalsWarning}`);
  console.log(
    `  → 종합: ${judgment.pass ? "채택 기준 충족" : "채택 기준 미달 — §9: 판정 프롬프트 1회 개정 후 재캘리브레이션(1회 한정), 그래도 미달이면 자동 검수 기각"}`,
  );

  // 불일치 상세 — 사람이 훑어볼 수 있게 전건 출력.
  if (report.criterionMismatches.length > 0) {
    console.log(`\n[criterion 불일치 상세 — ${report.criterionMismatches.length}건]`);
    for (const mismatch of report.criterionMismatches) {
      console.log(
        `  - (${shortTitle(mismatch.title)}) #${mismatch.criterionIndex}: 사람 ${mismatch.humanVerdict} → AI ${mismatch.aiVerdict}`,
      );
      if (mismatch.humanNote) console.log(`      사람 note: ${mismatch.humanNote}`);
      if (mismatch.aiNote) console.log(`      AI note: ${mismatch.aiNote}`);
    }
  } else {
    console.log("\n[criterion 불일치 상세] 없음 — 전건 일치");
  }
}

// ---- 기본 모드(확대 배치 AI 검수) --------------------------------------------------

interface DefaultModeOptions {
  model: string;
  limit: number;
  dryRun: boolean;
  maxCostUsd: number;
  force: boolean;
}

async function runDefaultMode(options: DefaultModeOptions): Promise<number> {
  const cohort = await readCohortFileV2();
  if (!cohort) {
    console.error(`[ai-review] cohort.json 이 없거나 형식이 깨졌습니다: ${cohortFilePath()}`);
    return 1;
  }

  const scan = await scanRunDirs();
  const skippedHuman: string[] = [];
  const skippedDone: string[] = [];
  const heldNoRun: string[] = [];
  const pending: LabRun[] = [];
  for (const entry of cohort.entries) {
    const state = scan.get(entry.grantId);
    if (state?.hasHumanReview) {
      skippedHuman.push(entry.grantId);
      continue;
    }
    if (!state?.latestOkRun) {
      heldNoRun.push(entry.grantId);
      continue;
    }
    const run = state.latestOkRun;
    if (!options.force && existsSync(aiReviewFilePath(run.source, run.sourceId, run.runId, options.model))) {
      skippedDone.push(entry.grantId);
      continue;
    }
    pending.push(run);
  }
  const targets = pending.slice(0, options.limit);

  console.log(
    `[ai-review] 기본 모드 · 판정 모델 ${options.model} · 코호트 ${cohort.entries.length}건` +
      (cohort.experimentLabel ? ` (${cohort.experimentLabel})` : ""),
  );
  console.log(
    `[ai-review] 제외(사람 검수 보유) ${skippedHuman.length} · 스킵(AI 검수 완료) ${skippedDone.length} · ` +
      `보류(ok 런 없음) ${heldNoRun.length} · 잔여 ${pending.length} → 이번 실행 대상 ${targets.length}건 (limit=${options.limit})`,
  );
  if (targets.length === 0) {
    console.error("[ai-review] 실행 대상이 0건입니다.");
    return 1;
  }

  const estimated = targets.reduce((sum, run) => sum + (estimateReviewCostUsd(options.model, run) ?? 0), 0);
  console.log(`[ai-review] 예상 비용 ≈ $${estimated.toFixed(2)} (추출 런 입력 토큰 + 오버헤드 기반 추정)`);

  if (options.dryRun) {
    console.log("[ai-review] --dry-run — 대상 목록만 출력하고 종료합니다(API 호출 0).");
    for (const run of targets) {
      const cost = estimateReviewCostUsd(options.model, run);
      console.log(
        `  - ${run.grantId} · ${shortTitle(run.title, 40)} · ${run.runId} · 예상 $${(cost ?? 0).toFixed(3)}`,
      );
    }
    return 0;
  }

  const apiKey = requireApiKey();
  console.log(`[ai-review] 실행 시작 — concurrency=${CONCURRENCY} · max-cost-usd=$${options.maxCostUsd}`);

  let okCount = 0;
  let failCount = 0;
  let refusalCount = 0;
  let driftCount = 0;
  let totalCostUsd = 0;
  let costCapped = false;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (costCapped) return;
      const index = nextIndex;
      if (index >= targets.length) return;
      nextIndex += 1;
      const run = targets[index]!;
      const ordinal = `${index + 1}/${targets.length}`;
      const label = `${shortTitle(run.title, 30)} (${run.runId})`;
      const startedMs = Date.now();
      // error 1회 재시도(§ CLI 스펙) — runAiReview 내부의 HTTP 재시도와 별개의 겉 재시도.
      for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
        try {
          const outcome = await runAiReview({ run, model: options.model, apiKey, force: options.force });
          const seconds = ((Date.now() - startedMs) / 1000).toFixed(1);
          if (outcome.status === "input_drift") {
            driftCount += 1;
            console.warn(`[ai-review] (${ordinal}) 원문 드리프트 — 스킵: ${label}`);
          } else if (outcome.status === "refusal") {
            refusalCount += 1;
            console.warn(`[ai-review] (${ordinal}) 판정 거부(refusal): ${label}`);
          } else {
            okCount += 1;
            const cost = outcome.file.costUsd ?? 0;
            totalCostUsd += cost;
            console.log(
              `[ai-review] (${ordinal}) ${outcome.status === "created" ? "완료" : "기존 재사용"}: ${label} · ${seconds}s · $${cost.toFixed(4)} · 누적 $${totalCostUsd.toFixed(4)}`,
            );
          }
          break;
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (attemptNo === 1) {
            console.warn(`[ai-review] (${ordinal}) 실패 — 1회 재시도: ${label} · ${message.slice(0, 200)}`);
            continue;
          }
          failCount += 1;
          console.error(`[ai-review] (${ordinal}) 실패(재시도 후에도): ${label} · ${message.slice(0, 400)}`);
        }
      }
      if (!costCapped && totalCostUsd >= options.maxCostUsd) {
        costCapped = true;
        console.log(
          `[ai-review] 누적 비용 $${totalCostUsd.toFixed(4)} ≥ 상한 $${options.maxCostUsd} — 신규 착수 중단(진행분은 완료).`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));

  console.log("\n===== AI 검수 배치 요약 =====");
  console.log(
    `완료 ${okCount} · 실패 ${failCount} · 판정 거부 ${refusalCount} · 원문 드리프트 ${driftCount} · ` +
      `미착수 ${targets.length - okCount - failCount - refusalCount - driftCount}`,
  );
  console.log(`총비용 $${totalCostUsd.toFixed(4)}${costCapped ? " · 비용 상한 도달" : ""}`);
  return 0;
}

// ---- 감사 대상 산출 모드 -----------------------------------------------------------

async function runAuditListMode(model: string): Promise<number> {
  const slug = modelSlug(model);
  const root = analysisLabDir();
  // 수집(사람 검수 보유 공고 제외 포함)은 감사 파일 생성(audit-store)과 같은 함수를 쓴다 —
  // 풀이 같아야 correct 20% 표본(풀 단위 셔플)이 감사 시트의 대상과 정확히 일치한다(§9 결정론).
  const reviews = (await collectAiReviewsForAudit(model)).map(toAiReviewForAudit);
  if (reviews.length === 0) {
    console.error(`[audit] 모델 ${model} 의 AI 검수 파일이 없습니다(*.ai-review.${slug}.json).`);
    return 1;
  }

  const selection = selectAuditTargets(reviews, { seed: AUDIT_SEED, sampleRatio: AUDIT_SAMPLE_RATIO });
  console.log(
    `[audit] 모델 ${model} · AI 검수 ${reviews.length}건 → 감사 대상 ${selection.targets.length}건 ` +
      `(비-correct 전수 + missed_condition 플래그 전수 + correct ${selection.correctTotal}건 중 ` +
      `시드 ${AUDIT_SEED} 결정론 ${Math.round(AUDIT_SAMPLE_RATIO * 100)}% = ${selection.sampledCorrectCount}건)`,
  );
  const widths = [24, 34, 30, 18];
  console.log(
    [padCell("종류", widths[0]!), padCell("공고", widths[1]!), padCell("대상", widths[2]!), padCell("AI 판정", widths[3]!), "note"].join(""),
  );
  for (const target of selection.targets) {
    const subject =
      target.criterionIndex !== undefined
        ? `criterion #${target.criterionIndex}`
        : `축 ${target.dimension}(${DIMENSION_LABELS[target.dimension!]})`;
    console.log(
      [
        padCell(target.kind, widths[0]!),
        padCell(shortTitle(target.title, 30), widths[1]!),
        padCell(subject, widths[2]!),
        padCell(target.aiVerdict, widths[3]!),
        target.aiNote ? shortTitle(target.aiNote, 60) : "",
      ].join(""),
    );
  }

  const stamp = new Date().toISOString().replace(/:/g, "");
  const outDir = join(root, "audit");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${stamp}.json`);
  await writeFile(
    outPath,
    `${JSON.stringify(
      {
        schema: "lab-ai-review-audit-v1",
        model,
        seed: AUDIT_SEED,
        sampleRatio: AUDIT_SAMPLE_RATIO,
        createdAt: new Date().toISOString(),
        reviewCount: reviews.length,
        correctTotal: selection.correctTotal,
        sampledCorrectCount: selection.sampledCorrectCount,
        targets: selection.targets,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`[audit] 저장: ${outPath}`);
  return 0;
}

// ---- 메인 -------------------------------------------------------------------------

async function main(): Promise<number> {
  const model = resolveAiReviewModel(readArg("model"));
  const force = hasFlag("force");

  if (hasFlag("audit-list")) {
    return runAuditListMode(model);
  }
  if (hasFlag("calibrate")) {
    return runCalibrateMode(model, force);
  }

  const limit = readNumberArg("limit", DEFAULT_LIMIT);
  const maxCostUsd = readNumberArg("max-cost-usd", DEFAULT_MAX_COST_USD);
  if (limit === null || !Number.isInteger(limit) || limit < 1) {
    console.error("[ai-review] 설정 오류: --limit 은 1 이상의 정수여야 합니다.");
    return 1;
  }
  if (maxCostUsd === null || maxCostUsd <= 0) {
    console.error("[ai-review] 설정 오류: --max-cost-usd 는 0보다 큰 숫자여야 합니다.");
    return 1;
  }
  return runDefaultMode({ model, limit, dryRun: hasFlag("dry-run"), maxCostUsd, force });
}

/** DB 커넥션이 로드된 경우에만 닫는다(dry-run·audit 은 no-op) — batch.ts 관행. */
async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 커넥션 정리 실패는 종료를 막지 않는다
  }
}

// verify 계열 스크립트의 커넥션 잔존 미종료 전례가 있어 명시적으로 정리·종료한다.
main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[ai-review] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });

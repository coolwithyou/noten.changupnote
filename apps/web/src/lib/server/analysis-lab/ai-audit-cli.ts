// 공모 딥분석 실험실 — AI 블라인드 감사 CLI (tsx 단독 실행, dev 서버 불필요, DB read-only).
// §9 완화 개정(2026-07-23 사용자 승인): 사람 UI 감사를 AI 2차 판정으로 자동화한다.
//
// 실행: pnpm lab:ai-audit -- [--dry-run] [--limit=50] [--max-cost-usd=5] [--model=...] [--force]
//   [--grant-ids=<uuid,uuid,...>] [--create-missing]
//   대상: 감사 파일(<runId>.audit.<채택모델슬러그>.json)이 이미 존재하고 미판정 항목
//   (humanVerdict null · aiAudit 미기록)이 있는 전 공고. 감사 파일 미생성 공고는 대상이
//   아니다(생성은 감사 시트 GET/audit-store 소관 — 대상 목록 동결 원칙).
//   단, 복구 재분석처럼 정확한 --grant-ids 를 함께 준 --create-missing 은 지정 런의 감사
//   파일을 먼저 동결한 뒤 같은 실행에서 판정한다.
//   --dry-run 은 대상·예상 비용만 출력(API 호출 0). --force 는 aiAudit 기록 항목 재판정
//   (humanVerdict 보유 항목은 어떤 경우에도 불변).
// 주의: --dry-run 이 아니면 실제 Anthropic API 비용이 발생한다. 사람 review.json 과
//   humanVerdict/note 는 절대 건드리지 않으며, 쓰기는 기존 감사 파일의 aiAudit* 필드
//   병합뿐이다(파일 삭제·재생성 없음).
import { join } from "node:path";
import { AI_REVIEW_ADOPTED, isAiAuditConcur, type LabAudit, type LabRun } from "@/features/dev/analysis-lab/contract";
import { AI_AUDIT_PROMPT_VERSION, resolveAiAuditModel, runAiAudit, selectPendingAuditItems } from "./ai-audit";
import { computeAiReviewCostUsd, modelSlug } from "./ai-review";
import {
  collectAiReviewsForAudit,
  isLabAuditComplete,
  loadOrCreateLabAudit,
  readLabAuditFileAt,
} from "./audit-store";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const DEFAULT_LIMIT = 50;
const CONCURRENCY = 2;
const DEFAULT_MAX_COST_USD = 5;

// ---- argv 파싱 (ai-review-cli 관행) -------------------------------------------------

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

// 콘솔 표 정렬(전각 2칸) — ai-review-cli 헬퍼 복제(그 파일은 CLI 라 import 불가).
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function shortTitle(title: string, max = 30): string {
  let width = 0;
  let out = "";
  for (const ch of title) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
    if (width > max) return `${out}\u2026`;
    out += ch;
  }
  return out;
}

function requireApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 가 없습니다 — 모노레포 루트 .env(.env.local)를 확인하세요.");
  }
  return apiKey;
}

/** 감사 비용 추정 — ai-review CLI 의 추정식 동형(추출 런 입력 토큰 + 오버헤드 ~8K + 출력 ~3K). */
function estimateAuditCostUsd(model: string, run: LabRun): number | null {
  const inputTokens = (run.usage?.inputTokens ?? Math.round(run.inputTotalChars / 2)) + 8_000;
  return computeAiReviewCostUsd(model, { inputTokens, outputTokens: 3_000, cacheReadTokens: null });
}

interface AuditTargetEntry {
  run: LabRun;
  audit: LabAudit;
  pendingCount: number;
  title: string;
}

async function main(): Promise<number> {
  const auditModel = resolveAiAuditModel(readArg("model"));
  const reviewModel = AI_REVIEW_ADOPTED.model;
  const force = hasFlag("force");
  const dryRun = hasFlag("dry-run");
  const grantIds = readCsvArg("grant-ids");
  const createMissing = hasFlag("create-missing");
  const limit = readNumberArg("limit", DEFAULT_LIMIT);
  const maxCostUsd = readNumberArg("max-cost-usd", DEFAULT_MAX_COST_USD);
  if (limit === null || !Number.isInteger(limit) || limit < 1) {
    console.error("[ai-audit] 설정 오류: --limit 은 1 이상의 정수여야 합니다.");
    return 1;
  }
  if (maxCostUsd === null || maxCostUsd <= 0) {
    console.error("[ai-audit] 설정 오류: --max-cost-usd 는 0보다 큰 숫자여야 합니다.");
    return 1;
  }
  if (createMissing && !grantIds) {
    console.error("[ai-audit] --create-missing 은 정확한 --grant-ids 와 함께 사용해야 합니다.");
    return 1;
  }
  // 클로저(worker) 안에서도 non-null 로 좁혀지도록 별도 상수에 고정한다.
  const costCapUsd: number = maxCostUsd;

  // [하드 가드 선제 확인] 감사 모델 === 검수 모델이면 전 대상이 무효 — 즉시 실패.
  if (auditModel === reviewModel) {
    console.error(
      `[ai-audit] 감사 모델(${auditModel})이 AI 검수 채택 모델(${reviewModel})과 같습니다 — 자기 확인 순환 금지(§9).`,
    );
    return 1;
  }

  console.log(
    `[ai-audit] 감사 모델 ${auditModel} · 검수(감사 파일) 모델 ${reviewModel} · promptVersion=${AI_AUDIT_PROMPT_VERSION}`,
  );

  // 대상 수집 — 채택 모델 AI 검수 풀(사람 review.json 보유 공고 제외)에서 감사 파일이
  // 이미 존재하는 런만. 감사 파일 미생성 공고는 안내만 하고 건너뛴다.
  const allCollected = await collectAiReviewsForAudit(reviewModel, { quiet: true });
  const collected = grantIds
    ? allCollected.filter((item) => grantIds.has(item.review.grantId))
    : allCollected;
  if (grantIds) {
    const found = new Set(collected.map((item) => item.review.grantId));
    const missing = [...grantIds].filter((grantId) => !found.has(grantId));
    if (missing.length > 0) {
      console.error(`[ai-audit] --grant-ids 중 채택 모델 AI 검수가 없는 공고: ${missing.join(", ")}`);
      return 1;
    }
  }
  if (createMissing) {
    for (const item of collected) {
      if (!item.run || item.run.error !== null) continue;
      const outcome = await loadOrCreateLabAudit({
        grantId: item.run.grantId,
        runId: item.run.runId,
        model: reviewModel,
      });
      if (outcome.status !== "ok") {
        console.error(`[ai-audit] 감사 파일 생성 실패: ${item.run.runId} (${outcome.status})`);
        return 1;
      }
      console.log(
        `[ai-audit] 감사 파일 ${outcome.created ? "생성" : "재사용"}: ${item.run.runId} · ${outcome.audit.items.length}항목`,
      );
    }
  }
  const slug = modelSlug(reviewModel);
  const targets: AuditTargetEntry[] = [];
  let noAuditFile = 0;
  let alreadyDone = 0;
  for (const item of collected) {
    if (!item.run || item.run.error !== null) continue;
    const audit = await readLabAuditFileAt(join(item.dir, `${item.review.runId}.audit.${slug}.json`));
    if (!audit) {
      noAuditFile += 1;
      continue;
    }
    const pendingCount = selectPendingAuditItems(audit, force).length;
    if (pendingCount === 0) {
      alreadyDone += 1;
      continue;
    }
    targets.push({ run: item.run, audit, pendingCount, title: item.title });
  }
  targets.sort((a, b) => a.run.grantId.localeCompare(b.run.grantId));
  const batch = targets.slice(0, limit);

  console.log(
    `[ai-audit] AI 검수 ${collected.length}건 스캔 — 감사 파일 없음 ${noAuditFile} · 판정 잔여 없음 ${alreadyDone} · ` +
      `대상 ${targets.length} → 이번 실행 ${batch.length}건 (limit=${limit}${force ? " · --force 재판정" : ""})`,
  );
  if (noAuditFile > 0) {
    console.log(
      `[ai-audit] 감사 파일 미생성 ${noAuditFile}건은 대상이 아닙니다 — 감사 시트(GET /api/dev/analysis-lab/audit)를 먼저 열어 대상 목록을 동결하세요.`,
    );
  }
  if (batch.length === 0) {
    console.log("[ai-audit] 실행 대상이 0건입니다 — 종료.");
    return 0;
  }

  const estimated = batch.reduce((sum, entry) => sum + (estimateAuditCostUsd(auditModel, entry.run) ?? 0), 0);
  console.log(`[ai-audit] 예상 비용 ≈ $${estimated.toFixed(2)} (추출 런 입력 토큰 + 오버헤드 기반 추정)`);

  if (dryRun) {
    console.log("[ai-audit] --dry-run — 대상 목록만 출력하고 종료합니다(API 호출 0).");
    for (const entry of batch) {
      console.log(
        `  - ${entry.run.grantId} · ${shortTitle(entry.title, 40)} · ${entry.run.runId} · ` +
          `미판정 ${entry.pendingCount}/${entry.audit.items.length}항목 · 예상 $${(estimateAuditCostUsd(auditModel, entry.run) ?? 0).toFixed(3)}`,
      );
    }
    return 0;
  }

  const apiKey = requireApiKey();
  console.log(`[ai-audit] 실행 시작 — concurrency=${CONCURRENCY} · max-cost-usd=$${costCapUsd}`);

  let okCount = 0;
  let failCount = 0;
  let refusalCount = 0;
  let driftCount = 0;
  let appliedTotal = 0;
  let concurTotal = 0;
  let disagreeTotal = 0;
  let unsureTotal = 0;
  let completedAudits = 0;
  let totalCostUsd = 0;
  let costCapped = false;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (costCapped) return;
      const index = nextIndex;
      if (index >= batch.length) return;
      nextIndex += 1;
      const entry = batch[index]!;
      const ordinal = `${index + 1}/${batch.length}`;
      const label = `${shortTitle(entry.title)} (${entry.run.runId})`;
      // 오류 1회 재시도 — ai-review CLI 관행(HTTP 재시도와 별개의 겉 재시도).
      for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
        try {
          const outcome = await runAiAudit({
            run: entry.run,
            audit: entry.audit,
            auditModel,
            apiKey,
            force,
          });
          if (outcome.status === "input_drift") {
            driftCount += 1;
            console.warn(`[ai-audit] (${ordinal}) 원문 드리프트 — 스킵: ${label}`);
          } else if (outcome.status === "refusal") {
            refusalCount += 1;
            console.warn(`[ai-audit] (${ordinal}) 판정 거부(refusal): ${label}`);
          } else if (outcome.status === "no_pending") {
            console.log(`[ai-audit] (${ordinal}) 판정 잔여 없음 — 스킵: ${label}`);
          } else {
            okCount += 1;
            appliedTotal += outcome.applied;
            concurTotal += outcome.concurCount;
            disagreeTotal += outcome.disagreeCount;
            unsureTotal += outcome.unsureCount;
            const cost = outcome.costUsd ?? 0;
            totalCostUsd += cost;
            // 저장 직후 완료 여부 — 일치만으로 완료됐으면 사람 감사 없이 게이트 편입된다.
            if (isLabAuditComplete(outcome.auditAfter)) completedAudits += 1;
            console.log(
              `[ai-audit] (${ordinal}) 완료: ${label} · ${(outcome.durationMs / 1000).toFixed(1)}s · ` +
                `판정 ${outcome.applied}항목(일치 ${outcome.concurCount} · 불일치 ${outcome.disagreeCount} · unsure ${outcome.unsureCount})` +
                ` · $${cost.toFixed(4)} · 누적 $${totalCostUsd.toFixed(4)}`,
            );
          }
          break;
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (attemptNo === 1) {
            console.warn(`[ai-audit] (${ordinal}) 실패 — 1회 재시도: ${label} · ${message.slice(0, 200)}`);
            continue;
          }
          failCount += 1;
          console.error(`[ai-audit] (${ordinal}) 실패(재시도 후에도): ${label} · ${message.slice(0, 400)}`);
        }
      }
      if (!costCapped && totalCostUsd >= costCapUsd) {
        costCapped = true;
        console.log(
          `[ai-audit] 누적 비용 $${totalCostUsd.toFixed(4)} ≥ 상한 $${costCapUsd} — 신규 착수 중단(진행분은 완료).`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()));

  console.log("\n===== AI 블라인드 감사 배치 요약 =====");
  console.log(
    `완료 ${okCount} · 실패 ${failCount} · 판정 거부 ${refusalCount} · 원문 드리프트 ${driftCount} · ` +
      `미착수 ${batch.length - okCount - failCount - refusalCount - driftCount}`,
  );
  console.log(
    `판정 항목 ${appliedTotal} — 일치(자동 확정) ${concurTotal} · 불일치 ${disagreeTotal} · unsure ${unsureTotal}` +
      ` (불일치·unsure ${disagreeTotal + unsureTotal}항목은 사람 감사 UI 판정 필요)`,
  );
  console.log(
    `완료 상태(전 항목 확정 — 게이트 편입 가능)가 된 감사 ${completedAudits}건 · 총비용 $${totalCostUsd.toFixed(4)}${costCapped ? " · 비용 상한 도달" : ""}`,
  );
  return 0;
}

function readCsvArg(name: string): ReadonlySet<string> | null {
  const raw = readArg(name);
  if (raw === undefined) return null;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`--${name}에는 값이 하나 이상 필요합니다.`);
  return new Set(values);
}

/** DB 커넥션이 로드된 경우에만 닫는다(dry-run 은 no-op) — ai-review-cli 관행. */
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
    console.error("[ai-audit] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });

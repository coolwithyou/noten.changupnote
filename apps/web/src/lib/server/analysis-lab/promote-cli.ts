// 공모 딥분석 실험실 — 확정 자산 승격 파이프라인 CLI (tsx 단독 실행, Phase B-4).
//
// ⚠️ 실험실 "DB 쓰기 0 원칙"의 **의도된 유일한 경계 통과 지점**이다. 검수·감사 확정
// criteria(B)를 grant_criteria 로, 확인 질문을 grant_confirmation_questions 로 발행한다.
// **기본은 dry-run** — 발행 계획(대상 grant·A→B criteria·질문·변환 드롭·답변 가드)만 출력하고
// DB 는 read 만 한다. 실쓰기는 프로토콜 게이트(잔여 48항목 사람 감사 → aggregate GO →
// lab:shadow 긍정) 후 **--write --confirm-go 두 플래그를 모두** 지정해야 열린다.
//
// 실행: pnpm lab:promote -- [--dry-run] [--write] [--confirm-go] [--grantId=<uuid>] [--limit=N]
//   --dry-run       기본값(명시 불요) — 계획 출력만
//   --write         실쓰기 의사 — --confirm-go 없이는 경고 + dry-run 강등
//   --confirm-go    프로토콜 게이트 통과 확인 — --write 없이는 경고 + dry-run 강등
//
// 쓰기 경로(--write --confirm-go, per-grant 트랜잭션):
//   기존 질문 삭제 → 기존 grant_criteria 삭제 → 확정 B criteria 삽입(교체 — 커버리지 13.5x가
//   B 도입의 명분) → 질문 삽입(criteriaPosition 으로 새 criteria 행 id 연결) → 해당 grantId
//   의 match_state 삭제(normalizedGrantPublisher 패턴 — confirmed dedup 컴포넌트 확장 포함,
//   다음 로드에서 재계산). 답변 보존 가드: 답변이 참조된 grant 는 발행 거부(cascade 방지).
import { AI_REVIEW_ADOPTED } from "@/features/dev/analysis-lab/contract";
import { eq, inArray } from "drizzle-orm";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import { labConfirmationsFilePath, readLabConfirmationsFile } from "./confirmations";
import {
  applyPublishGuards,
  dedupePromotionSources,
  executePromotionWrites,
  planGrantPromotion,
  resolvePromotionMode,
  PROMOTION_PROTOCOL_NOTICE,
  type GrantPromotionPlan,
  type PromotionWritePort,
} from "./promote";
import { selectReviewedRuns } from "./reviewed-runs";
import { getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import { criterionInsertValues } from "../ingestion/normalizedGrantPublisher";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

// ---- argv 파싱 (confirmations-cli 관행) ----------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// 콘솔 표 정렬(전각 2칸) — ai-audit-cli 헬퍼 복제(CLI 파일이라 import 불가 관행).
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

function shortTitle(title: string, max = 34): string {
  let width = 0;
  let out = "";
  for (const ch of title) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
    if (width > max) return `${out}…`;
    out += ch;
  }
  return out;
}

// ---- Drizzle 쓰기 포트 (per-grant 트랜잭션 — --write --confirm-go 에서만 호출) ---------

function createDrizzlePromotionPort(
  db: CunoteDb,
  confirmedLinks: Array<{ canonicalGrantId: string; memberGrantId: string }>,
): PromotionWritePort {
  return {
    async publishGrant(plan: GrantPromotionPlan) {
      return db.transaction(async (tx) => {
        // 답변 보존 재확인 — 계획 수립과 실행 사이의 답변 유입 방어(가드와 같은 사유).
        const [existingAnswer] = await tx
          .select({ questionId: schema.companyGrantConfirmations.questionId })
          .from(schema.companyGrantConfirmations)
          .where(eq(schema.companyGrantConfirmations.grantId, plan.grantId))
          .limit(1);
        if (existingAnswer) {
          throw new Error("답변 보존 가드(트랜잭션 재확인): 발행 사이 답변 유입 — 발행 중단");
        }

        // 교체형 발행: 질문 → criteria 순으로 지운다(질문의 grant_criteria_id 는 SET NULL 이라
        // 순서 무관하지만, 끊긴 질문을 남기지 않는 것이 멱등 계약이다).
        const questionsDeleted = (
          await tx
            .delete(schema.grantConfirmationQuestions)
            .where(eq(schema.grantConfirmationQuestions.grantId, plan.grantId))
            .returning({ id: schema.grantConfirmationQuestions.id })
        ).length;
        const criteriaDeleted = (
          await tx
            .delete(schema.grantCriteria)
            .where(eq(schema.grantCriteria.grantId, plan.grantId))
            .returning({ id: schema.grantCriteria.id })
        ).length;

        // criteriaPosition ↔ 새 행 id 매핑을 위해 행 단위 insert(발행 규모가 작아 비용 무시).
        const insertedIds: string[] = [];
        for (const criterion of plan.criteria) {
          const [row] = await tx
            .insert(schema.grantCriteria)
            .values(criterionInsertValues(plan.grantId, criterion))
            .returning({ id: schema.grantCriteria.id });
          if (!row) throw new Error(`criteria insert 실패: ${plan.grantId}`);
          insertedIds.push(row.id);
        }

        let questionsInserted = 0;
        for (const question of plan.questions) {
          const grantCriteriaId = insertedIds[question.criteriaPosition];
          if (!grantCriteriaId) {
            throw new Error(`질문 앵커 누락: position ${question.criteriaPosition} (${plan.grantId})`);
          }
          await tx.insert(schema.grantConfirmationQuestions).values({
            grantId: plan.grantId,
            grantCriteriaId,
            criterionRef: question.criterionRef as unknown as Record<string, unknown>,
            prompt: question.prompt,
            options: question.options as unknown as Array<Record<string, unknown>>,
            answerType: question.answerType,
            reusable: question.reusable,
            conditionKey: question.conditionKey,
            promptVer: question.promptVer,
            provenance: question.provenance as unknown as Record<string, unknown>,
          });
          questionsInserted += 1;
        }

        // publisher 패턴: confirmed dedup 컴포넌트로 확장해 match_state 삭제 — 다음 로드에서 재계산.
        const affectedGrantIds = expandConfirmedGrantComponentIds([plan.grantId], confirmedLinks);
        const matchStatesDeleted = (
          await tx
            .delete(schema.matchState)
            .where(inArray(schema.matchState.grantId, affectedGrantIds))
            .returning({ companyId: schema.matchState.companyId })
        ).length;

        return {
          criteriaDeleted,
          criteriaInserted: insertedIds.length,
          questionsDeleted,
          questionsInserted,
          matchStatesDeleted,
        };
      });
    },
  };
}

// ---- 메인 ----------------------------------------------------------------------------

function countByGrant(rows: Array<{ grantId: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.grantId, (counts.get(row.grantId) ?? 0) + 1);
  return counts;
}

async function main(): Promise<number> {
  const mode = resolvePromotionMode({ write: hasFlag("write"), confirmGo: hasFlag("confirm-go") });
  const grantFilter = readArg("grantId")?.trim();
  const limitRaw = readArg("limit");
  const limit = limitRaw === undefined ? null : Number(limitRaw);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    console.error("[promote] 설정 오류: --limit 은 1 이상의 정수여야 합니다.");
    return 1;
  }

  console.log(
    `[promote] 확정 자산 승격 파이프라인 — 실험실 "DB 쓰기 0 원칙"의 의도된 유일한 경계 통과 지점 · ` +
      `모드: ${mode.write ? "⚠️ 실발행(--write --confirm-go)" : "dry-run(기본)"}`,
  );
  if (mode.warning) console.warn(`[promote] ${mode.warning}`);

  // 1) 대상 수집 — confirmations-cli 와 동일 규칙: 사람 review 보유 런 + 감사 완료 병합 런,
  //    grantId 중복 시 사람 우선(dedupePromotionSources).
  const reviewedSelection = await selectReviewedRuns({ scanAll: false });
  const audited = await loadAuditedConfirmedReviews({ model: AI_REVIEW_ADOPTED.model, scanAll: false });
  let sources = dedupePromotionSources(reviewedSelection.reviewed, audited.confirmed);
  if (grantFilter) sources = sources.filter((source) => source.run.grantId === grantFilter);
  if (limit !== null) sources = sources.slice(0, limit);
  // 필터·limit 적용 후 집계 — 표기 수치와 실제 대상이 일치해야 한다.
  const humanCount = sources.filter((source) => source.origin === "human").length;
  console.log(
    `[promote] 검수 확정 런 ${sources.length}건(사람 ${humanCount} · 감사 병합 ${sources.length - humanCount}` +
      `${audited.pending.length > 0 ? ` · 감사 미완 제외 ${audited.pending.length}` : ""}` +
      `${grantFilter ? " · --grantId 필터" : ""}${limit !== null ? ` · limit=${limit}` : ""})`,
  );
  if (sources.length === 0) {
    console.log("[promote] 승격 대상이 0건입니다 — 종료.");
    console.log(`[promote] 프로토콜: ${PROMOTION_PROTOCOL_NOTICE}`);
    return 0;
  }

  // 2) 계획 수립(순수) — 질문 소스는 v3 인라인 + 사이드카 병합(readLabRunWithConfirmations 동형:
  //    같은 사이드카 경로·같은 병합 함수. 런 객체를 이미 들고 있어 재로드 대신 직접 병합한다).
  const plans: GrantPromotionPlan[] = [];
  for (const source of sources) {
    const sidecar = await readLabConfirmationsFile(
      labConfirmationsFilePath(source.run.source, source.run.sourceId, source.run.runId),
    );
    plans.push(planGrantPromotion({ run: source.run, review: source.review, origin: source.origin, sidecar }));
  }

  // 3) DB read — 현재 A criteria 수·기존 질문 수·답변 수·공고 존재 확인(dry-run 도 여기까지).
  const db = getCunoteDb();
  const grantIds = plans.map((plan) => plan.grantId);
  const grantRows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(inArray(schema.grants.id, grantIds));
  const knownGrantIds = new Set(grantRows.map((row) => row.id));
  const currentCriteriaCounts = countByGrant(
    await db
      .select({ grantId: schema.grantCriteria.grantId })
      .from(schema.grantCriteria)
      .where(inArray(schema.grantCriteria.grantId, grantIds)),
  );
  const existingQuestionCounts = countByGrant(
    await db
      .select({ grantId: schema.grantConfirmationQuestions.grantId })
      .from(schema.grantConfirmationQuestions)
      .where(inArray(schema.grantConfirmationQuestions.grantId, grantIds)),
  );
  const answerCounts = countByGrant(
    await db
      .select({ grantId: schema.companyGrantConfirmations.grantId })
      .from(schema.companyGrantConfirmations)
      .where(inArray(schema.companyGrantConfirmations.grantId, grantIds)),
  );

  // 공고가 DB 에 없으면 발행 불가(FK) — 계획에서 제외하고 무은폐로 경고(shadow 전례).
  const missing = plans.filter((plan) => !knownGrantIds.has(plan.grantId));
  for (const plan of missing) {
    console.warn(`[promote] 공고를 DB 에서 찾지 못해 제외: ${plan.grantId} (${shortTitle(plan.title)})`);
  }
  const present = plans.filter((plan) => knownGrantIds.has(plan.grantId));

  // 4) 발행 가드 — 답변 보존(핵심) + 변환 계약 실패 + 발행 0건.
  const guarded = applyPublishGuards(present, answerCounts);
  const refusedByGrant = new Map(guarded.refused.map((item) => [item.plan.grantId, item]));

  // 5) 발행 계획 출력 — grant별 현재 A → 발행 B·질문·변환 드롭, 가드 사유.
  console.log(`\n===== 승격 발행 계획 — 대상 ${present.length}건 (발행 가능 ${guarded.publishable.length} · 가드 거부 ${guarded.refused.length}) =====`);
  for (const plan of present) {
    const refusal = refusedByGrant.get(plan.grantId);
    const inlineCount = plan.questions.filter((question) => question.inline).length;
    const existingQuestions = existingQuestionCounts.get(plan.grantId) ?? 0;
    console.log(
      `  - ${plan.grantId} · ${shortTitle(plan.title)} · [${plan.origin === "human" ? "사람 검수" : "감사 병합"}] ` +
        `A ${currentCriteriaCounts.get(plan.grantId) ?? 0}건 → B ${plan.criteria.length}건` +
        `(강등 ${plan.conversion.downgraded} · 드롭 ${plan.conversion.dropped}${plan.conversion.error ? " · 계약실패" : ""}) · ` +
        `질문 ${plan.questions.length}건(인라인 ${inlineCount} · 보강 ${plan.questions.length - inlineCount}` +
        `${plan.droppedQuestionCandidates > 0 ? ` · 앵커 상실 ${plan.droppedQuestionCandidates}` : ""})` +
        `${existingQuestions > 0 ? ` · 재발행(기존 질문 ${existingQuestions}건 교체)` : ""}` +
        `${refusal ? ` · ⛔ 발행 거부: ${refusal.detail}` : ""}`,
    );
  }
  const totals = {
    criteriaBefore: present.reduce((sum, plan) => sum + (currentCriteriaCounts.get(plan.grantId) ?? 0), 0),
    criteriaAfter: guarded.publishable.reduce((sum, plan) => sum + plan.criteria.length, 0),
    questions: guarded.publishable.reduce((sum, plan) => sum + plan.questions.length, 0),
    dropped: present.reduce((sum, plan) => sum + plan.conversion.dropped, 0),
    downgraded: present.reduce((sum, plan) => sum + plan.conversion.downgraded, 0),
  };
  console.log(
    `[합계] 발행 가능 ${guarded.publishable.length}공고: criteria A ${totals.criteriaBefore}건 → B ${totals.criteriaAfter}건 · ` +
      `질문 ${totals.questions}건 · 변환 드롭 ${totals.dropped}·강등 ${totals.downgraded}` +
      `${missing.length > 0 ? ` · DB 부재 제외 ${missing.length}공고` : ""}`,
  );

  // 6) 실쓰기 — 두 플래그가 모두 있을 때만 도달한다.
  if (mode.write) {
    if (guarded.publishable.length === 0) {
      console.log("[promote] 발행 가능한 공고가 0건입니다 — 쓰기 없이 종료.");
      return 0;
    }
    console.log(`\n[promote] ⚠️ 실발행 시작 — ${guarded.publishable.length}공고 (per-grant 트랜잭션)`);
    const confirmedLinks = await db
      .select({
        canonicalGrantId: schema.dedupLinks.canonicalGrantId,
        memberGrantId: schema.dedupLinks.memberGrantId,
      })
      .from(schema.dedupLinks)
      .where(eq(schema.dedupLinks.confirmed, true));
    const port = createDrizzlePromotionPort(db, confirmedLinks);
    const outcomes = await executePromotionWrites(guarded.publishable, port);
    let okCount = 0;
    for (const outcome of outcomes) {
      if (outcome.error !== null) {
        console.error(`[promote] 발행 실패(격리): ${outcome.plan.grantId} · ${outcome.error}`);
        continue;
      }
      okCount += 1;
      console.log(
        `[promote] 발행 완료: ${outcome.plan.grantId} · criteria ${outcome.result.criteriaDeleted}→${outcome.result.criteriaInserted} · ` +
          `질문 ${outcome.result.questionsDeleted}→${outcome.result.questionsInserted} · match_state 무효화 ${outcome.result.matchStatesDeleted}`,
      );
    }
    console.log(`[promote] 실발행 요약: 성공 ${okCount} · 실패 ${outcomes.length - okCount}`);
  } else {
    console.log(`\n[promote] dry-run — DB 쓰기 없음(read 만 수행). 프로토콜: ${PROMOTION_PROTOCOL_NOTICE}`);
  }
  return 0;
}

/** DB 커넥션이 로드된 경우에만 닫는다 — verify 계열 미종료 전례 방지(confirmations-cli 관행). */
async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 커넥션 정리 실패는 종료를 막지 않는다
  }
}

main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[promote] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });

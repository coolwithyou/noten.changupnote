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
//   안정 키 기준 grant_criteria upsert → 질문 upsert(ID/FK 보존) → 소멸 질문 soft-invalidate
//   → 소멸 criterion만 삭제 → 해당 grantId의 match_state 삭제.
import { join } from "node:path";
import { AI_REVIEW_ADOPTED } from "@/features/dev/analysis-lab/contract";
import { eq, inArray } from "drizzle-orm";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import {
  collectAiReviewsForAudit,
  readLabAuditFileAt,
} from "./audit-store";
import { labConfirmationsFilePath, readLabConfirmationsFile } from "./confirmations";
import {
  humanReviewOverlayFilePath,
  readHumanReviewOverlayFile,
} from "./human-review-overlay";
import {
  applyPublishGuards,
  dedupePromotionSources,
  executePromotionWrites,
  findExistingQuestionForStableKey,
  indexExistingCriteriaByStableKey,
  planGrantPromotion,
  resolvePromotionMode,
  PROMOTION_PROTOCOL_NOTICE,
  type GrantPromotionPlan,
  type PromotionWritePort,
} from "./promote";
import { selectReviewedRuns } from "./reviewed-runs";
import { modelSlug } from "./run-store";
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
        const existingCriteria = await tx
          .select({
            id: schema.grantCriteria.id,
            stableKey: schema.grantCriteria.stableKey,
            dimension: schema.grantCriteria.dimension,
            operator: schema.grantCriteria.operator,
            value: schema.grantCriteria.value,
            kind: schema.grantCriteria.kind,
            sourceSpan: schema.grantCriteria.sourceSpan,
          })
          .from(schema.grantCriteria)
          .where(eq(schema.grantCriteria.grantId, plan.grantId));
        const existingQuestions = await tx
          .select({
            id: schema.grantConfirmationQuestions.id,
            grantCriteriaId: schema.grantConfirmationQuestions.grantCriteriaId,
            criterionStableKey: schema.grantConfirmationQuestions.criterionStableKey,
          })
          .from(schema.grantConfirmationQuestions)
          .where(eq(schema.grantConfirmationQuestions.grantId, plan.grantId));

        const criteriaByKey = indexExistingCriteriaByStableKey(existingCriteria);

        const criterionIds: string[] = [];
        let criteriaInserted = 0;
        let criteriaUpdated = 0;
        for (const [position, criterion] of plan.criteria.entries()) {
          const stableKey = plan.criterionStableKeys[position];
          if (!stableKey) throw new Error(`criterion 안정 키 누락: position ${position}`);
          const values = { ...criterionInsertValues(plan.grantId, criterion), stableKey };
          const existing = criteriaByKey.get(stableKey);
          if (existing) {
            const [row] = await tx
              .update(schema.grantCriteria)
              .set(values)
              .where(eq(schema.grantCriteria.id, existing.id))
              .returning({ id: schema.grantCriteria.id });
            if (!row) throw new Error(`criteria update 실패: ${existing.id}`);
            criterionIds.push(row.id);
            criteriaUpdated += 1;
          } else {
            const [row] = await tx
              .insert(schema.grantCriteria)
              .values(values)
              .onConflictDoUpdate({
                target: [schema.grantCriteria.grantId, schema.grantCriteria.stableKey],
                set: values,
              })
              .returning({ id: schema.grantCriteria.id });
            if (!row) throw new Error(`criteria upsert 실패: ${plan.grantId}`);
            criterionIds.push(row.id);
            criteriaInserted += 1;
          }
        }

        const activeQuestionIds = new Set<string>();
        let questionsInserted = 0;
        let questionsUpdated = 0;
        for (const question of plan.questions) {
          const grantCriteriaId = criterionIds[question.criteriaPosition];
          if (!grantCriteriaId) {
            throw new Error(`질문 앵커 누락: position ${question.criteriaPosition} (${plan.grantId})`);
          }
          const values = {
            grantId: plan.grantId,
            grantCriteriaId,
            criterionStableKey: question.criterionStableKey,
            criterionRef: question.criterionRef as unknown as Record<string, unknown>,
            prompt: question.prompt,
            options: question.options as unknown as Array<Record<string, unknown>>,
            answerType: question.answerType,
            reusable: question.reusable,
            conditionKey: question.conditionKey,
            promptVer: question.promptVer,
            provenance: question.provenance as unknown as Record<string, unknown>,
            invalidatedAt: null,
            invalidationReason: null,
          };
          const existing = findExistingQuestionForStableKey(
            existingQuestions,
            question.criterionStableKey,
            grantCriteriaId,
          );
          if (existing) {
            const [row] = await tx
              .update(schema.grantConfirmationQuestions)
              .set(values)
              .where(eq(schema.grantConfirmationQuestions.id, existing.id))
              .returning({ id: schema.grantConfirmationQuestions.id });
            if (!row) throw new Error(`question update 실패: ${existing.id}`);
            activeQuestionIds.add(row.id);
            questionsUpdated += 1;
          } else {
            const [row] = await tx
              .insert(schema.grantConfirmationQuestions)
              .values(values)
              .onConflictDoUpdate({
                target: [
                  schema.grantConfirmationQuestions.grantId,
                  schema.grantConfirmationQuestions.criterionStableKey,
                ],
                set: values,
              })
              .returning({ id: schema.grantConfirmationQuestions.id });
            if (!row) throw new Error(`question upsert 실패: ${question.criterionStableKey}`);
            activeQuestionIds.add(row.id);
            questionsInserted += 1;
          }
        }

        const staleQuestionIds = existingQuestions
          .map((row) => row.id)
          .filter((id) => !activeQuestionIds.has(id));
        const questionsInvalidated = staleQuestionIds.length === 0
          ? 0
          : (
              await tx
                .update(schema.grantConfirmationQuestions)
                .set({
                  grantCriteriaId: null,
                  invalidatedAt: new Date(),
                  invalidationReason: "anchor_criterion_removed_or_changed",
                })
                .where(inArray(schema.grantConfirmationQuestions.id, staleQuestionIds))
                .returning({ id: schema.grantConfirmationQuestions.id })
            ).length;

        const staleCriterionIds = existingCriteria
          .map((row) => row.id)
          .filter((id) => !criterionIds.includes(id));
        const criteriaDeleted = staleCriterionIds.length === 0
          ? 0
          : (
              await tx
                .delete(schema.grantCriteria)
                .where(inArray(schema.grantCriteria.id, staleCriterionIds))
                .returning({ id: schema.grantCriteria.id })
            ).length;

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
          criteriaInserted,
          criteriaUpdated,
          questionsInserted,
          questionsUpdated,
          questionsInvalidated,
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

  // 1) 대상 수집 — 사람 review > 감사 완료 병합 > 미완 감사/overlay resolver 순서.
  //    미완 런도 criterion 단위로 pending(needs_review=true)과 확정분을 함께 발행 후보로 삼는다.
  const reviewedSelection = await selectReviewedRuns({ scanAll: false });
  const audited = await loadAuditedConfirmedReviews({ model: AI_REVIEW_ADOPTED.model, scanAll: false });
  let sources = dedupePromotionSources(reviewedSelection.reviewed, audited.confirmed);
  const sourceGrantIds = new Set(sources.map((source) => source.run.grantId));
  const pendingRunIds = new Set(audited.pending.map((item) => item.runId));
  const pendingByGrant = new Map<string, Awaited<ReturnType<typeof collectAiReviewsForAudit>>[number]>();
  for (const candidate of await collectAiReviewsForAudit(AI_REVIEW_ADOPTED.model, { quiet: true })) {
    if (
      !candidate.run
      || candidate.run.error !== null
      || !pendingRunIds.has(candidate.run.runId)
      || sourceGrantIds.has(candidate.run.grantId)
    ) continue;
    const previous = pendingByGrant.get(candidate.run.grantId);
    if (!previous || (candidate.run.startedAt ?? "") > (previous.run?.startedAt ?? "")) {
      pendingByGrant.set(candidate.run.grantId, candidate);
    }
  }
  for (const candidate of pendingByGrant.values()) {
    const run = candidate.run!;
    const audit = await readLabAuditFileAt(
      join(candidate.dir, `${run.runId}.audit.${modelSlug(AI_REVIEW_ADOPTED.model)}.json`),
    );
    const overlay = await readHumanReviewOverlayFile(
      humanReviewOverlayFilePath(run.source, run.sourceId, run.runId),
    );
    sources.push({
      run,
      aiReview: candidate.review,
      audit,
      overlay,
      origin: "pending",
    });
  }
  sources.sort((left, right) => left.run.grantId.localeCompare(right.run.grantId));
  if (grantFilter) sources = sources.filter((source) => source.run.grantId === grantFilter);
  if (limit !== null) sources = sources.slice(0, limit);
  // 필터·limit 적용 후 집계 — 표기 수치와 실제 대상이 일치해야 한다.
  const humanCount = sources.filter((source) => source.origin === "human").length;
  const auditedCount = sources.filter((source) => source.origin === "audited").length;
  const pendingCount = sources.filter((source) => source.origin === "pending").length;
  console.log(
    `[promote] 항목별 승격 후보 ${sources.length}건(사람 ${humanCount} · 감사 병합 ${auditedCount}` +
      ` · resolver 미완 ${pendingCount}` +
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
    plans.push(planGrantPromotion({
      run: source.run,
      review: source.review,
      aiReview: source.aiReview,
      audit: source.audit,
      overlay: source.overlay,
      origin: source.origin,
      sidecar,
    }));
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
  // 공고가 DB 에 없으면 발행 불가(FK) — 계획에서 제외하고 무은폐로 경고(shadow 전례).
  const missing = plans.filter((plan) => !knownGrantIds.has(plan.grantId));
  for (const plan of missing) {
    console.warn(`[promote] 공고를 DB 에서 찾지 못해 제외: ${plan.grantId} (${shortTitle(plan.title)})`);
  }
  const present = plans.filter((plan) => knownGrantIds.has(plan.grantId));

  // 4) 발행 가드 — 변환 계약 실패 + 발행 0건. 답변은 안정 키 upsert로 보존한다.
  const guarded = applyPublishGuards(present);
  const refusedByGrant = new Map(guarded.refused.map((item) => [item.plan.grantId, item]));

  // 5) 발행 계획 출력 — grant별 현재 A → 발행 B·질문·변환 드롭, 가드 사유.
  console.log(`\n===== 승격 발행 계획 — 대상 ${present.length}건 (발행 가능 ${guarded.publishable.length} · 가드 거부 ${guarded.refused.length}) =====`);
  for (const plan of present) {
    const refusal = refusedByGrant.get(plan.grantId);
    const inlineCount = plan.questions.filter((question) => question.inline).length;
    const existingQuestions = existingQuestionCounts.get(plan.grantId) ?? 0;
    console.log(
      `  - ${plan.grantId} · ${shortTitle(plan.title)} · [` +
        `${plan.origin === "human" ? "사람 검수" : plan.origin === "audited" ? "감사 병합" : "항목 resolver"}] ` +
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
          `criteria 갱신 ${outcome.result.criteriaUpdated} · 질문 추가 ${outcome.result.questionsInserted}` +
          `/갱신 ${outcome.result.questionsUpdated}/무효화 ${outcome.result.questionsInvalidated} · ` +
          `match_state 무효화 ${outcome.result.matchStatesDeleted}`,
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

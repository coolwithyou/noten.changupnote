import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type {
  GrantConfirmationAnswerDto,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
  MatchCard,
} from "@cunote/contracts";
import { isNonMatchingApplicationCriterion, toMatchCard } from "@cunote/core";
import type { ServiceRepositories } from "@cunote/core";
import { getCunoteDb } from "../db/client";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { canWriteCompany } from "../auth/companyAccessPolicy";
import { acquireGrantPublicationLock } from "../ingestion/grantPublicationLock";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import { getServiceRepositories, resolveProductCompanyProfile } from "../serviceData";
import { annotateMatchCardWriteSupport } from "./annotateWriteSupport";
import {
  normalizeConfirmationAnswerType,
  normalizeConfirmationOptions,
  toConfirmationAnswerDto,
  toConfirmationQuestionDto,
  validateConfirmationAnswers,
  type ConfirmationAnswerInput,
  type ConfirmationQuestionRecord,
} from "./grantConfirmationAnswers";
import { refreshMatchStates } from "./matchStateRefresh";

/** 확인 질문 요청 오류 — webActionError 가 status/code 를 그대로 응답에 싣는다. */
export class ConfirmationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ConfirmationRequestError";
  }
}

interface QuestionRow extends ConfirmationQuestionRecord {
  prompt: string;
}

/** 공고의 확인 질문 + 현 company 의 기존 답변. 질문이 없으면 빈 목록(404 아님). */
export async function listGrantConfirmations(input: {
  companyId: string;
  grantId: string;
}, db: CunoteDb = getCunoteDb()): Promise<GrantConfirmationsResult> {
  if (!isUuid(input.grantId)) {
    // DB id 가 없는 공고(샘플 경로)는 질문도 있을 수 없다 — uuid 캐스트 오류 대신 빈 목록.
    return { grantId: input.grantId, questions: [], answers: [] };
  }
  const questions = await loadQuestionRows(input.grantId, db);
  const answers = questions.length > 0
    ? await loadAnswerDtos({
      companyId: input.companyId,
      grantId: input.grantId,
      questionIds: new Set(questions.map((question) => question.id)),
      questionsById: new Map(questions.map((question) => [question.id, question])),
      db,
    })
    : [];
  return {
    grantId: input.grantId,
    questions: questions.map(toConfirmationQuestionDto),
    answers,
  };
}

/**
 * 답변 검증 → disqualified 스냅샷과 함께 upsert → (company, grant) 스코프 매칭 재계산.
 * 응답에 재계산 카드가 실려 UI 가 4상태 버킷 이동을 즉시 반영한다.
 */
export async function submitGrantConfirmations(input: {
  companyId: string;
  userId: string;
  grantId: string;
  answers: ConfirmationAnswerInput[];
  asOf?: Date;
}, dependencies: {
  /** 격리 PostgreSQL 통합검사용. 제품 호출은 기본 client와 실제 재계산을 사용한다. */
  db?: CunoteDb;
  recalculate?: typeof recalculateGrantMatch;
  recalculation?: RecalculateGrantMatchDependencies;
} = {}): Promise<GrantConfirmationSubmitResult> {
  const asOf = input.asOf ?? new Date();
  if (!isUuid(input.grantId)) {
    throw new ConfirmationRequestError(
      "confirmation_questions_not_found",
      "이 공고의 확인 질문이 없습니다.",
      404,
      "grantId",
    );
  }
  const db = dependencies.db ?? getCunoteDb();
  const persisted = await db.transaction(async (tx) => {
    // 모든 grant publisher와 같은 advisory lock을 먼저 잡는다. 이후 company→membership→question
    // 순서로 잠가 권한 철회·질문 교체와 답변 저장 사이의 TOCTOU를 닫는다.
    await acquireGrantPublicationLock(tx, input.grantId);
    const [company] = await tx
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.id, input.companyId))
      .limit(1)
      .for("update");
    if (!company) {
      throw new ConfirmationRequestError(
        "company_write_forbidden",
        "회사 편집 권한이 변경되었습니다.",
        403,
        "companyId",
      );
    }
    const [membership] = await tx
      .select({ role: schema.userCompany.role })
      .from(schema.userCompany)
      .where(and(
        eq(schema.userCompany.companyId, input.companyId),
        eq(schema.userCompany.userId, input.userId),
      ))
      .limit(1)
      .for("share");
    if (!membership || !canWriteCompany(membership.role)) {
      throw new ConfirmationRequestError(
        "company_write_forbidden",
        "회사 편집 권한이 변경되었습니다.",
        403,
        "companyId",
      );
    }

    const questions = await loadQuestionRows(
      input.grantId,
      tx,
      new Set(input.answers.map((answer) => answer.questionId)),
      true,
    );
    if (questions.length === 0) {
      throw new ConfirmationRequestError(
        "confirmation_questions_not_found",
        "이 공고의 확인 질문이 없습니다.",
        404,
        "grantId",
      );
    }
    const validation = validateConfirmationAnswers({ questions, answers: input.answers });
    if (!validation.ok) {
      throw new ConfirmationRequestError(validation.code, validation.message, 409, "answers");
    }

    const v2Answers = validation.answers.filter((answer) => answer.binding);
    if (v2Answers.length > 0) {
      const currentSource = await loadCurrentGrantSourceBinding(tx, input.grantId, true);
      if (!currentSource) {
        throw new ConfirmationRequestError(
          "confirmation_grant_not_found",
          "공고 원문을 확인할 수 없습니다.",
          409,
          "grantId",
        );
      }
      if (v2Answers.some((answer) => (
        answer.binding?.sourceRawSha256 !== currentSource.sourceRawSha256
        || answer.binding?.sourceRevisionSha256 !== currentSource.sourceRevisionSha256
      ))) {
        throw new ConfirmationRequestError(
          "confirmation_source_stale",
          "공고 원문이 변경되었습니다. 최신 질문을 다시 확인해 주세요.",
          409,
          "answers",
        );
      }
    }

    const saved: GrantConfirmationAnswerDto[] = [];
    for (const answer of validation.answers) {
      const [current] = await tx
        .select({ answerRevision: schema.companyGrantConfirmations.answerRevision })
        .from(schema.companyGrantConfirmations)
        .where(and(
          eq(schema.companyGrantConfirmations.companyId, input.companyId),
          eq(schema.companyGrantConfirmations.questionId, answer.questionId),
        ))
        .limit(1)
        .for("update");
      const currentRevision = current?.answerRevision ?? 0;
      if (answer.binding && answer.expectedAnswerRevision !== currentRevision) {
        throw new ConfirmationRequestError(
          "confirmation_answer_conflict",
          "다른 화면에서 답변이 변경되었습니다. 다시 불러와 주세요.",
          409,
          "answers",
        );
      }
      const nextRevision = currentRevision + 1;
      const row = {
        answer: { values: answer.values },
        disqualified: answer.disqualified,
        evaluation: answer.evaluation ?? null,
        evaluationCriterionId: answer.binding?.criterionId ?? null,
        sourceRevisionSha256: answer.binding?.sourceRevisionSha256 ?? null,
        sourceRawSha256: answer.binding?.sourceRawSha256 ?? null,
        questionDefinitionSha256: answer.binding?.definitionSha256 ?? null,
        questionVersion: answer.binding?.questionVersion ?? null,
        answerRevision: nextRevision,
        answeredBy: input.userId,
        answeredAt: asOf,
      };
      await tx
        .insert(schema.companyGrantConfirmations)
        .values({
          companyId: input.companyId,
          grantId: input.grantId,
          questionId: answer.questionId,
          ...row,
        })
        .onConflictDoUpdate({
          target: [
            schema.companyGrantConfirmations.companyId,
            schema.companyGrantConfirmations.questionId,
          ],
          set: row,
        });
      saved.push({
        questionId: answer.questionId,
        values: answer.values,
        ...(answer.evaluation
          ? { evaluation: answer.evaluation, answerRevision: nextRevision }
          : { disqualified: answer.disqualified }),
        answeredAt: asOf.toISOString(),
      });
    }
    return { questions, saved };
  });

  try {
    const recalculated = await (dependencies.recalculate ?? ((recalculateInput) =>
      recalculateGrantMatch(recalculateInput, dependencies.recalculation)))({
      companyId: input.companyId,
      userId: input.userId,
      grantId: input.grantId,
      questionCount: persisted.questions.length,
      asOf,
    });
    return { grantId: input.grantId, saved: persisted.saved, ...recalculated };
  } catch (error) {
    // 답변 원장 transaction은 이미 commit됐다. 후속 계산 실패를 저장 실패로 응답하면 사용자가
    // 같은 답변을 다시 보내 CAS 충돌을 만들 수 있으므로 성공 receipt와 재조회 필요 상태를 분리한다.
    console.warn("grant_confirmation_recalculation_not_completed", error);
    return {
      grantId: input.grantId,
      saved: persisted.saved,
      match: null,
      refresh: { plannedCount: 0, savedCount: 0, status: "failed" },
    };
  }
}

/**
 * 저장 직후 해당 공고 1건만 재계산한다. refreshMatchStates 가 확인 답변을 배치 로드해
 * 엔진 입력에 싣고, match_state 쓰기는 company 스코프 프로필일 때만 수행한다
 * (profileQuestionMatchRefresh 의 stateScope 가드와 동일 원칙).
 * 공고를 찾지 못하면 답변 저장은 유지한 채 재계산만 생략한다.
 */
interface RecalculateGrantMatchDependencies {
  repositories?: ServiceRepositories<unknown>;
  resolveProfile?: (
    input: Parameters<typeof resolveProductCompanyProfile>[0],
  ) => Promise<Pick<Awaited<ReturnType<typeof resolveProductCompanyProfile>>, "profile" | "stateScope">>;
  annotateCards?: typeof annotateMatchCardWriteSupport;
}

export async function recalculateGrantMatch(input: {
  companyId: string;
  userId: string;
  grantId: string;
  questionCount: number;
  asOf: Date;
}, dependencies: RecalculateGrantMatchDependencies = {}): Promise<Pick<GrantConfirmationSubmitResult, "match" | "refresh">> {
  const repositories = dependencies.repositories ?? getServiceRepositories();
  const [resolution, grant] = await Promise.all([
    (dependencies.resolveProfile ?? resolveProductCompanyProfile)({
      context: "owned_read",
      companyId: input.companyId,
      userId: input.userId,
      asOf: input.asOf.toISOString(),
    }),
    repositories.grants.findGrantById(input.grantId, { asOf: input.asOf }),
  ]);
  if (!grant) {
    return { match: null, refresh: { plannedCount: 0, savedCount: 0, status: "failed" } };
  }

  const shouldWriteSharedState = resolution.stateScope === "company";
  const { plan, savedCount, staleCount } = await refreshMatchStates({
    repositories,
    companyId: input.companyId,
    userId: input.userId,
    company: resolution.profile,
    grants: [grant],
    asOf: input.asOf,
    write: shouldWriteSharedState,
  });
  const state = plan.states.find((entry) => entry.grantId === input.grantId) ?? plan.states[0];
  if (!state || staleCount > 0) {
    return {
      match: null,
      refresh: {
        plannedCount: plan.states.length,
        savedCount,
        status: staleCount > 0 ? "stale" : "failed",
      },
    };
  }

  const card: MatchCard = toMatchCard({ item: grant, match: state.match }, { asOf: input.asOf });
  const [annotated] = await (dependencies.annotateCards ?? annotateMatchCardWriteSupport)([card]);
  const match: MatchCard = { ...(annotated ?? card), confirmationQuestionCount: input.questionCount };
  return {
    match,
    refresh: {
      plannedCount: plan.states.length,
      savedCount,
      status: shouldWriteSharedState ? "succeeded" : "not_persisted_user_scope",
    },
  };
}

async function loadQuestionRows(
  grantId: string,
  db: CunoteDbSession = getCunoteDb(),
  questionIds?: ReadonlySet<string>,
  lock = false,
): Promise<QuestionRow[]> {
  const conditions = [
    eq(schema.grantConfirmationQuestions.grantId, grantId),
    isNull(schema.grantConfirmationQuestions.invalidatedAt),
  ];
  if (questionIds) {
    if (questionIds.size === 0) return [];
    conditions.push(inArray(schema.grantConfirmationQuestions.id, [...questionIds]));
  }
  const query = db
    .select({
      id: schema.grantConfirmationQuestions.id,
      prompt: schema.grantConfirmationQuestions.prompt,
      answerType: schema.grantConfirmationQuestions.answerType,
      options: schema.grantConfirmationQuestions.options,
      createdAt: schema.grantConfirmationQuestions.createdAt,
      grantCriteriaId: schema.grantConfirmationQuestions.grantCriteriaId,
      evaluationCriterionId: schema.grantConfirmationQuestions.evaluationCriterionId,
      evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
      sourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
      sourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
      definitionSha256: schema.grantConfirmationQuestions.definitionSha256,
      version: schema.grantConfirmationQuestions.version,
    })
    .from(schema.grantConfirmationQuestions)
    .where(and(...conditions))
    .orderBy(
      asc(schema.grantConfirmationQuestions.createdAt),
      asc(schema.grantConfirmationQuestions.id),
    );
  const rows = lock ? await query.for("update") : await query;
  const currentSource = !lock
    && rows.some((row) => row.evaluationContractVersion === "confirmation-evaluation-v2")
    ? await loadCurrentGrantSourceBinding(db, grantId)
    : null;
  const criterionIds = [...new Set(rows.flatMap((row) => {
    const id = row.evaluationContractVersion === "confirmation-evaluation-v2"
      ? row.evaluationCriterionId
      : row.grantCriteriaId;
    return id ? [id] : [];
  }))];
  if (criterionIds.length === 0) return [];
  const criteria = await db
    .select({
      id: schema.grantCriteria.id,
      grantId: schema.grantCriteria.grantId,
      dimension: schema.grantCriteria.dimension,
      kind: schema.grantCriteria.kind,
      operator: schema.grantCriteria.operator,
      sourceSpan: schema.grantCriteria.sourceSpan,
    })
    .from(schema.grantCriteria)
    .where(inArray(schema.grantCriteria.id, criterionIds));
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  return rows
    .flatMap((row) => {
      const isV2 = row.evaluationContractVersion === "confirmation-evaluation-v2";
      if (row.evaluationContractVersion && !isV2) return [];
      const criterionId = isV2 ? row.evaluationCriterionId : row.grantCriteriaId;
      const criterion = criterionId ? criterionById.get(criterionId) : null;
      if (!criterion || criterion.grantId !== grantId) return [];
      const confirmedCriterionId = criterion.id;
      const binding = isV2
        && row.sourceRevisionSha256
        && row.sourceRawSha256
        && /^[0-9a-f]{64}$/.test(row.sourceRevisionSha256)
        && /^[0-9a-f]{64}$/.test(row.sourceRawSha256)
        ? {
            contractVersion: "confirmation-evaluation-v2" as const,
            criterionId: confirmedCriterionId,
            sourceRevisionSha256: row.sourceRevisionSha256,
            sourceRawSha256: row.sourceRawSha256,
            definitionSha256: row.definitionSha256,
            questionVersion: row.version,
          }
        : undefined;
      if (isV2 && !binding) return [];
      if (binding && !lock && (
        !currentSource
        || binding.sourceRawSha256 !== currentSource.sourceRawSha256
        || binding.sourceRevisionSha256 !== currentSource.sourceRevisionSha256
      )) return [];
      return [{ row, criterion, binding }];
    })
    .filter((row) => !isNonMatchingApplicationCriterion({
      dimension: row.criterion.dimension,
      kind: row.criterion.kind,
      operator: row.criterion.operator,
      source_span: row.criterion.sourceSpan,
    }))
    .map(({ row, criterion, binding }) => ({
      id: row.id,
      prompt: row.prompt,
      answerType: normalizeConfirmationAnswerType(row.answerType),
      options: normalizeConfirmationOptions(row.options, row.evaluationContractVersion),
      kind: criterion.kind,
      ...(binding ? { binding } : {}),
    }))
    .filter((row) => row.options.length >= 2);
}

async function loadCurrentGrantSourceBinding(
  db: CunoteDbSession,
  grantId: string,
  lockRaw = false,
): Promise<{ sourceRawSha256: string; sourceRevisionSha256: string } | null> {
  return loadDeepAnalysisSourceBinding({ db, grantId, lockRaw });
}

async function loadAnswerDtos(input: {
  companyId: string;
  grantId: string;
  questionIds: ReadonlySet<string>;
  questionsById: ReadonlyMap<string, QuestionRow>;
  db?: CunoteDbSession;
}): Promise<GrantConfirmationAnswerDto[]> {
  const db = input.db ?? getCunoteDb();
  const rows = await db
    .select({
      questionId: schema.companyGrantConfirmations.questionId,
      answer: schema.companyGrantConfirmations.answer,
      disqualified: schema.companyGrantConfirmations.disqualified,
      evaluation: schema.companyGrantConfirmations.evaluation,
      evaluationCriterionId: schema.companyGrantConfirmations.evaluationCriterionId,
      sourceRevisionSha256: schema.companyGrantConfirmations.sourceRevisionSha256,
      sourceRawSha256: schema.companyGrantConfirmations.sourceRawSha256,
      questionDefinitionSha256: schema.companyGrantConfirmations.questionDefinitionSha256,
      questionVersion: schema.companyGrantConfirmations.questionVersion,
      answerRevision: schema.companyGrantConfirmations.answerRevision,
      answeredAt: schema.companyGrantConfirmations.answeredAt,
    })
    .from(schema.companyGrantConfirmations)
    .where(and(
      eq(schema.companyGrantConfirmations.companyId, input.companyId),
      eq(schema.companyGrantConfirmations.grantId, input.grantId),
    ));
  return rows
    .filter((row) => {
      if (!input.questionIds.has(row.questionId)) return false;
      const binding = input.questionsById.get(row.questionId)?.binding;
      if (!binding) return row.evaluation === null;
      return row.evaluationCriterionId === binding.criterionId
        && row.sourceRevisionSha256 === binding.sourceRevisionSha256
        && row.sourceRawSha256 === binding.sourceRawSha256
        && row.questionDefinitionSha256 === binding.definitionSha256
        && row.questionVersion === binding.questionVersion;
    })
    .map(toConfirmationAnswerDto);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

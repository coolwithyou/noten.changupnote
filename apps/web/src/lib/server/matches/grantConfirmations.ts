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
import {
  loadDeepAnalysisSourceBinding,
  loadDeepAnalysisSourceBindings,
} from "../deep-analysis/prepareInput";
import { getServiceRepositories, resolveProductCompanyProfile } from "../serviceData";
import { annotateMatchCardWriteSupport } from "./annotateWriteSupport";
import {
  normalizeConfirmationAnswerType,
  normalizeConfirmationOptions,
  isConfirmationEvaluation,
  sameConfirmationBinding,
  toConfirmationAnswerDto,
  toConfirmationQuestionDto,
  validateConfirmationAnswers,
  type ConfirmationAnswerInput,
  type ConfirmationQuestionRecord,
} from "./grantConfirmationAnswers";
import {
  buildCompanyFactReuseIdentity,
  isCompanyFactWithdrawal,
  optionValueForEvaluation,
  resolveCompanyFactAnswer,
  sameCompanyFactIdentity,
  type CompanyFactAnswerCandidate,
  type CompanyFactReuseIdentity,
} from "./companyFactReuse";
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
  grantId: string;
  companyFactIdentity: CompanyFactReuseIdentity | null;
}

/** 공고의 확인 질문 + 현 company 의 기존 답변. 질문이 없으면 빈 목록(404 아님). */
export async function listGrantConfirmations(input: {
  companyId: string;
  grantId: string;
}, db: CunoteDb = getCunoteDb()): Promise<Omit<GrantConfirmationsResult, "canSubmit">> {
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

    const questionById = new Map(questions.map((question) => [question.id, question]));
    let companyFactCandidates: CompanyFactAnswerCandidate[] = [];
    const companyFactAnswers = validation.answers.flatMap((answer) => {
      const identity = questionById.get(answer.questionId)?.companyFactIdentity;
      return identity && answer.evaluation ? [{ answer, identity }] : [];
    });
    if (companyFactAnswers.length > 0) {
      companyFactCandidates = await loadCompanyFactAnswerCandidates({
        companyId: input.companyId,
        db: tx,
      });
      const submittedIdentities = new Set<string>();
      for (const item of companyFactAnswers) {
        if (submittedIdentities.has(item.identity.semanticSha256)) {
          throw new ConfirmationRequestError(
            "confirmation_company_fact_duplicated",
            "같은 회사 사실에 대한 답변이 한 요청에 중복됐습니다.",
            409,
            "answers",
          );
        }
        submittedIdentities.add(item.identity.semanticSha256);
        const currentFact = resolveCompanyFactAnswer({
          identity: item.identity,
          candidates: companyFactCandidates,
        });
        if (
          item.answer.expectedCompanyFactRevision === undefined
          || item.answer.expectedCompanyFactRevision !== (currentFact?.companyFactRevision ?? null)
        ) {
          throw new ConfirmationRequestError(
            "confirmation_company_fact_conflict",
            "다른 공고에서 같은 회사 정보가 변경되었습니다. 다시 불러와 주세요.",
            409,
            "answers",
          );
        }
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
      const question = questionById.get(answer.questionId);
      let companyFactRevision: string | undefined;
      if (question?.companyFactIdentity && answer.evaluation) {
        companyFactCandidates = companyFactCandidates.filter((candidate) => (
          candidate.questionId !== answer.questionId
        ));
        companyFactCandidates.push({
          questionId: answer.questionId,
          grantId: input.grantId,
          identity: question.companyFactIdentity,
          evaluation: answer.evaluation,
          answerRevision: nextRevision,
          answeredAt: asOf,
        });
        companyFactRevision = resolveCompanyFactAnswer({
          identity: question.companyFactIdentity,
          candidates: companyFactCandidates,
        })?.companyFactRevision;
      }
      saved.push({
        questionId: answer.questionId,
        values: answer.values,
        ...(answer.evaluation
          ? { evaluation: answer.evaluation, answerRevision: nextRevision }
          : { disqualified: answer.disqualified }),
        answeredAt: asOf.toISOString(),
        ...(companyFactRevision ? { companyFactRevision } : {}),
      });
    }
    const relatedGrantIds = companyFactAnswers.length > 0
      ? await loadRelatedCompanyFactGrantIds({
        db: tx,
        identities: companyFactAnswers.map((item) => item.identity),
      })
      : [];
    return { questions, saved, relatedGrantIds };
  });

  try {
    const recalculated = await (dependencies.recalculate ?? ((recalculateInput) =>
      recalculateGrantMatch(recalculateInput, dependencies.recalculation)))({
      companyId: input.companyId,
      userId: input.userId,
      grantId: input.grantId,
      questionCount: persisted.questions.length,
      relatedGrantIds: persisted.relatedGrantIds,
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

/** 저장된 공고 답변을 철회한다. company_fact는 같은 의미로 투영되는 답변 원본을 함께 제거한다. */
export async function withdrawGrantConfirmation(input: {
  companyId: string;
  userId: string;
  grantId: string;
  questionId: string;
  binding?: ConfirmationAnswerInput["binding"];
  expectedAnswerRevision: number;
  expectedCompanyFactRevision?: string | null;
  asOf?: Date;
}, dependencies: {
  db?: CunoteDb;
  recalculate?: typeof recalculateGrantMatch;
  recalculation?: RecalculateGrantMatchDependencies;
} = {}): Promise<GrantConfirmationSubmitResult> {
  const asOf = input.asOf ?? new Date();
  if (!isUuid(input.grantId)) {
    throw new ConfirmationRequestError("confirmation_questions_not_found", "이 공고의 확인 질문이 없습니다.", 404, "grantId");
  }
  const db = dependencies.db ?? getCunoteDb();
  const persisted = await db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, input.grantId);
    const [company] = await tx.select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.id, input.companyId))
      .limit(1)
      .for("update");
    if (!company) {
      throw new ConfirmationRequestError("company_write_forbidden", "회사 편집 권한이 변경되었습니다.", 403, "companyId");
    }
    const [membership] = await tx.select({ role: schema.userCompany.role })
      .from(schema.userCompany)
      .where(and(
        eq(schema.userCompany.companyId, input.companyId),
        eq(schema.userCompany.userId, input.userId),
      ))
      .limit(1)
      .for("share");
    if (!membership || !canWriteCompany(membership.role)) {
      throw new ConfirmationRequestError("company_write_forbidden", "회사 편집 권한이 변경되었습니다.", 403, "companyId");
    }

    const [question] = await loadQuestionRows(input.grantId, tx, new Set([input.questionId]), true);
    if (!question) {
      throw new ConfirmationRequestError("confirmation_question_not_found", "이 공고의 확인 질문이 아닙니다.", 404, "questionId");
    }
    if (question.binding) {
      if (!input.binding || !sameConfirmationBinding(input.binding, question.binding)) {
        throw new ConfirmationRequestError("confirmation_question_stale", "질문이나 공고 원문이 변경되었습니다. 다시 확인해 주세요.", 409, "binding");
      }
      const currentSource = await loadCurrentGrantSourceBinding(tx, input.grantId, true);
      if (
        !currentSource
        || currentSource.sourceRawSha256 !== question.binding.sourceRawSha256
        || currentSource.sourceRevisionSha256 !== question.binding.sourceRevisionSha256
      ) {
        throw new ConfirmationRequestError("confirmation_source_stale", "공고 원문이 변경되었습니다. 최신 질문을 다시 확인해 주세요.", 409, "binding");
      }
    } else if (input.binding) {
      throw new ConfirmationRequestError("confirmation_question_binding_unexpected", "이 질문에는 신규 평가 결속을 사용할 수 없습니다.", 409, "binding");
    }

    const [direct] = await tx.select({ answerRevision: schema.companyGrantConfirmations.answerRevision })
      .from(schema.companyGrantConfirmations)
      .where(and(
        eq(schema.companyGrantConfirmations.companyId, input.companyId),
        eq(schema.companyGrantConfirmations.questionId, input.questionId),
      ))
      .limit(1)
      .for("update");
    if (input.expectedAnswerRevision !== (direct?.answerRevision ?? 0)) {
      throw new ConfirmationRequestError("confirmation_answer_conflict", "다른 화면에서 답변이 변경되었습니다. 다시 불러와 주세요.", 409, "answerRevision");
    }

    let relatedGrantIds = [input.grantId];
    if (question.companyFactIdentity) {
      const candidates = await loadCompanyFactAnswerCandidates({ companyId: input.companyId, db: tx });
      const currentFact = resolveCompanyFactAnswer({
        identity: question.companyFactIdentity,
        candidates,
      });
      if (
        input.expectedCompanyFactRevision === undefined
        || input.expectedCompanyFactRevision !== (currentFact?.companyFactRevision ?? null)
      ) {
        throw new ConfirmationRequestError(
          "confirmation_company_fact_conflict",
          "다른 공고에서 같은 회사 정보가 변경되었습니다. 다시 불러와 주세요.",
          409,
          "companyFactRevision",
        );
      }
      relatedGrantIds = await loadRelatedCompanyFactGrantIds({
        db: tx,
        identities: [question.companyFactIdentity],
      });
      const binding = question.binding!;
      const row = {
        answer: { values: [], withdrawn: true },
        disqualified: false,
        evaluation: "unknown" as const,
        evaluationCriterionId: binding.criterionId,
        sourceRevisionSha256: binding.sourceRevisionSha256,
        sourceRawSha256: binding.sourceRawSha256,
        questionDefinitionSha256: binding.definitionSha256,
        questionVersion: binding.questionVersion,
        answerRevision: (direct?.answerRevision ?? 0) + 1,
        answeredBy: input.userId,
        answeredAt: asOf,
      };
      await tx.insert(schema.companyGrantConfirmations).values({
        companyId: input.companyId,
        grantId: input.grantId,
        questionId: input.questionId,
        ...row,
      }).onConflictDoUpdate({
        target: [
          schema.companyGrantConfirmations.companyId,
          schema.companyGrantConfirmations.questionId,
        ],
        set: row,
      });
    } else if (direct) {
      await tx.delete(schema.companyGrantConfirmations).where(and(
        eq(schema.companyGrantConfirmations.companyId, input.companyId),
        eq(schema.companyGrantConfirmations.questionId, input.questionId),
      ));
    }
    return { relatedGrantIds };
  });

  try {
    const recalculated = await (dependencies.recalculate ?? ((recalculateInput) =>
      recalculateGrantMatch(recalculateInput, dependencies.recalculation)))({
      companyId: input.companyId,
      userId: input.userId,
      grantId: input.grantId,
      questionCount: 1,
      relatedGrantIds: persisted.relatedGrantIds,
      asOf,
    });
    return { grantId: input.grantId, saved: [], ...recalculated };
  } catch (error) {
    console.warn("grant_confirmation_withdrawal_recalculation_not_completed", error);
    return {
      grantId: input.grantId,
      saved: [],
      match: null,
      refresh: { plannedCount: 0, savedCount: 0, status: "failed" },
    };
  }
}

/**
 * 저장 직후 현재 공고와 같은 company_fact를 소비하는 공고를 함께 재계산한다.
 * refreshMatchStates가 확인 답변을 배치 로드해 엔진 입력에 싣고, match_state 쓰기는 company 스코프 프로필일 때만 수행한다
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
  relatedGrantIds?: string[];
  asOf: Date;
}, dependencies: RecalculateGrantMatchDependencies = {}): Promise<Pick<GrantConfirmationSubmitResult, "match" | "refresh">> {
  const repositories = dependencies.repositories ?? getServiceRepositories();
  const grantIds = [...new Set([input.grantId, ...(input.relatedGrantIds ?? [])])];
  const [resolution, loadedGrants] = await Promise.all([
    (dependencies.resolveProfile ?? resolveProductCompanyProfile)({
      context: "owned_read",
      companyId: input.companyId,
      userId: input.userId,
      asOf: input.asOf.toISOString(),
    }),
    Promise.all(grantIds.map((grantId) => repositories.grants.findGrantById(grantId, { asOf: input.asOf }))),
  ]);
  const grants = loadedGrants.filter((grant): grant is NonNullable<typeof grant> => grant !== null);
  const grant = grants.find((candidate) => candidate.grant.id === input.grantId) ?? null;
  if (!grant) {
    return { match: null, refresh: { plannedCount: 0, savedCount: 0, status: "failed" } };
  }

  const shouldWriteSharedState = resolution.stateScope === "company";
  const { plan, savedCount, staleCount } = await refreshMatchStates({
    repositories,
    companyId: input.companyId,
    userId: input.userId,
    company: resolution.profile,
    grants,
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
      grantId: schema.grantConfirmationQuestions.grantId,
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
      reusable: schema.grantConfirmationQuestions.reusable,
      conditionKey: schema.grantConfirmationQuestions.conditionKey,
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
      value: schema.grantCriteria.value,
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
    .map(({ row, criterion, binding }) => {
      const answerType = normalizeConfirmationAnswerType(row.answerType);
      const options = normalizeConfirmationOptions(row.options, row.evaluationContractVersion);
      const companyFactIdentity = buildCompanyFactReuseIdentity({
        questionId: row.id,
        grantId: row.grantId,
        reusable: row.reusable,
        conditionKey: row.conditionKey,
        evaluationContractVersion: row.evaluationContractVersion,
        answerType,
        options,
        criterion: {
          dimension: criterion.dimension,
          kind: criterion.kind,
          operator: criterion.operator,
          value: criterion.value,
        },
      });
      return {
        id: row.id,
        grantId: row.grantId,
        prompt: row.prompt,
        answerType,
        options,
        kind: criterion.kind,
        companyFactIdentity,
        ...(binding ? { binding } : {}),
      };
    })
    .filter((row) => row.options.length >= 2);
}

async function loadCurrentGrantSourceBinding(
  db: CunoteDbSession,
  grantId: string,
  lockRaw = false,
): Promise<{ sourceRawSha256: string; sourceRevisionSha256: string } | null> {
  return loadDeepAnalysisSourceBinding({ db, grantId, lockRaw });
}

async function loadRelatedCompanyFactGrantIds(input: {
  db: CunoteDbSession;
  identities: readonly CompanyFactReuseIdentity[];
}): Promise<string[]> {
  if (input.identities.length === 0) return [];
  const conditionKeys = [...new Set(input.identities.map((identity) => identity.conditionKey))];
  const rows = await input.db
    .select({
      questionId: schema.grantConfirmationQuestions.id,
      grantId: schema.grantConfirmationQuestions.grantId,
      evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
      questionSourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
      questionSourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
      reusable: schema.grantConfirmationQuestions.reusable,
      conditionKey: schema.grantConfirmationQuestions.conditionKey,
      answerType: schema.grantConfirmationQuestions.answerType,
      options: schema.grantConfirmationQuestions.options,
      criterionGrantId: schema.grantCriteria.grantId,
      criterionDimension: schema.grantCriteria.dimension,
      criterionKind: schema.grantCriteria.kind,
      criterionOperator: schema.grantCriteria.operator,
      criterionValue: schema.grantCriteria.value,
    })
    .from(schema.grantConfirmationQuestions)
    .innerJoin(
      schema.grantCriteria,
      eq(schema.grantCriteria.id, schema.grantConfirmationQuestions.evaluationCriterionId),
    )
    .where(and(
      inArray(schema.grantConfirmationQuestions.conditionKey, conditionKeys),
      eq(schema.grantConfirmationQuestions.reusable, "company_fact"),
      eq(schema.grantConfirmationQuestions.evaluationContractVersion, "confirmation-evaluation-v2"),
      isNull(schema.grantConfirmationQuestions.invalidatedAt),
    ));
  const currentSourceByGrant = await loadDeepAnalysisSourceBindings({
    db: input.db,
    grantIds: [...new Set(rows.map((row) => row.grantId))],
  });
  return [...new Set(rows.flatMap((row) => {
    if (
      row.criterionGrantId !== row.grantId
      || row.questionSourceRawSha256 !== currentSourceByGrant.get(row.grantId)?.sourceRawSha256
      || row.questionSourceRevisionSha256 !== currentSourceByGrant.get(row.grantId)?.sourceRevisionSha256
    ) return [];
    const identity = buildCompanyFactReuseIdentity({
      questionId: row.questionId,
      grantId: row.grantId,
      reusable: row.reusable,
      conditionKey: row.conditionKey,
      evaluationContractVersion: row.evaluationContractVersion,
      answerType: normalizeConfirmationAnswerType(row.answerType),
      options: normalizeConfirmationOptions(row.options, row.evaluationContractVersion),
      criterion: {
        dimension: row.criterionDimension,
        kind: row.criterionKind,
        operator: row.criterionOperator,
        value: row.criterionValue,
      },
    });
    return identity && input.identities.some((candidate) => sameCompanyFactIdentity(candidate, identity))
      ? [row.grantId]
      : [];
  }))];
}

async function loadAnswerDtos(input: {
  companyId: string;
  grantId: string;
  questionIds: ReadonlySet<string>;
  questionsById: ReadonlyMap<string, QuestionRow>;
  db?: CunoteDbSession;
}): Promise<GrantConfirmationAnswerDto[]> {
  const db = input.db ?? getCunoteDb();
  const directRows = await db
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
  const directAnswers = directRows
    .filter((row) => {
      if (!input.questionIds.has(row.questionId)) return false;
      const question = input.questionsById.get(row.questionId);
      if (question?.companyFactIdentity) return false;
      const binding = question?.binding;
      if (!binding) return row.evaluation === null;
      return row.evaluationCriterionId === binding.criterionId
        && row.sourceRevisionSha256 === binding.sourceRevisionSha256
        && row.sourceRawSha256 === binding.sourceRawSha256
        && row.questionDefinitionSha256 === binding.definitionSha256
        && row.questionVersion === binding.questionVersion;
    })
    .map(toConfirmationAnswerDto);

  const reusableQuestions = [...input.questionsById.values()]
    .filter((question) => question.companyFactIdentity !== null);
  if (reusableQuestions.length === 0) return directAnswers;

  const candidates = await loadCompanyFactAnswerCandidates({
    companyId: input.companyId,
    db,
  });
  const projected = reusableQuestions.flatMap((question): GrantConfirmationAnswerDto[] => {
    const identity = question.companyFactIdentity!;
    const direct = directRows.find((row) => (
      row.questionId === question.id
      && answerMatchesQuestionBinding(row, question)
    ));
    const resolved = resolveCompanyFactAnswer({ identity, candidates });
    if (!resolved) {
      return direct && isCompanyFactWithdrawal(direct.answer)
        ? [{
            questionId: question.id,
            values: [],
            answerRevision: direct.answerRevision,
            answeredAt: direct.answeredAt.toISOString(),
          }]
        : [];
    }
    const value = optionValueForEvaluation({ options: question.options }, resolved.evaluation);
    if (!value) return [];
    return [{
      questionId: question.id,
      values: [value],
      evaluation: resolved.evaluation,
      answerRevision: direct?.answerRevision ?? 0,
      answeredAt: resolved.answeredAt.toISOString(),
      companyFactRevision: resolved.companyFactRevision,
      ...(resolved.sourceQuestionId !== question.id ? { reusedFromCompanyFact: true } : {}),
    }];
  });
  return [...directAnswers, ...projected];
}

async function loadCompanyFactAnswerCandidates(input: {
  companyId: string;
  db: CunoteDbSession;
}): Promise<CompanyFactAnswerCandidate[]> {
  const rows = await input.db
    .select({
      questionId: schema.grantConfirmationQuestions.id,
      questionGrantId: schema.grantConfirmationQuestions.grantId,
      evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
      questionSourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
      questionSourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
      questionDefinitionSha256: schema.grantConfirmationQuestions.definitionSha256,
      questionVersion: schema.grantConfirmationQuestions.version,
      reusable: schema.grantConfirmationQuestions.reusable,
      conditionKey: schema.grantConfirmationQuestions.conditionKey,
      answerType: schema.grantConfirmationQuestions.answerType,
      options: schema.grantConfirmationQuestions.options,
      criterionId: schema.grantCriteria.id,
      criterionGrantId: schema.grantCriteria.grantId,
      criterionDimension: schema.grantCriteria.dimension,
      criterionKind: schema.grantCriteria.kind,
      criterionOperator: schema.grantCriteria.operator,
      criterionValue: schema.grantCriteria.value,
      evaluation: schema.companyGrantConfirmations.evaluation,
      answer: schema.companyGrantConfirmations.answer,
      answerCriterionId: schema.companyGrantConfirmations.evaluationCriterionId,
      answerSourceRevisionSha256: schema.companyGrantConfirmations.sourceRevisionSha256,
      answerSourceRawSha256: schema.companyGrantConfirmations.sourceRawSha256,
      answerDefinitionSha256: schema.companyGrantConfirmations.questionDefinitionSha256,
      answerQuestionVersion: schema.companyGrantConfirmations.questionVersion,
      answerRevision: schema.companyGrantConfirmations.answerRevision,
      answeredAt: schema.companyGrantConfirmations.answeredAt,
    })
    .from(schema.companyGrantConfirmations)
    .innerJoin(
      schema.grantConfirmationQuestions,
      eq(schema.companyGrantConfirmations.questionId, schema.grantConfirmationQuestions.id),
    )
    .innerJoin(
      schema.grantCriteria,
      eq(schema.grantCriteria.id, schema.grantConfirmationQuestions.evaluationCriterionId),
    )
    .where(and(
      eq(schema.companyGrantConfirmations.companyId, input.companyId),
      eq(schema.grantConfirmationQuestions.reusable, "company_fact"),
      eq(schema.grantConfirmationQuestions.evaluationContractVersion, "confirmation-evaluation-v2"),
      isNull(schema.grantConfirmationQuestions.invalidatedAt),
    ));
  const currentSourceByGrant = await loadDeepAnalysisSourceBindings({
    db: input.db,
    grantIds: [...new Set(rows.map((row) => row.questionGrantId))],
  });
  return rows.flatMap((row): CompanyFactAnswerCandidate[] => {
    const currentSource = currentSourceByGrant.get(row.questionGrantId);
    const evaluation = isCompanyFactWithdrawal(row.answer) ? "withdrawn" : row.evaluation;
    if (
      (evaluation !== "withdrawn" && !isConfirmationEvaluation(evaluation))
      || row.criterionGrantId !== row.questionGrantId
      || row.answerCriterionId !== row.criterionId
      || row.answerSourceRevisionSha256 !== row.questionSourceRevisionSha256
      || row.answerSourceRawSha256 !== row.questionSourceRawSha256
      || row.answerDefinitionSha256 !== row.questionDefinitionSha256
      || row.answerQuestionVersion !== row.questionVersion
      || row.questionSourceRawSha256 !== currentSource?.sourceRawSha256
      || row.questionSourceRevisionSha256 !== currentSource?.sourceRevisionSha256
    ) return [];
    const options = normalizeConfirmationOptions(row.options, row.evaluationContractVersion);
    const identity = buildCompanyFactReuseIdentity({
      questionId: row.questionId,
      grantId: row.questionGrantId,
      reusable: row.reusable,
      conditionKey: row.conditionKey,
      evaluationContractVersion: row.evaluationContractVersion,
      answerType: normalizeConfirmationAnswerType(row.answerType),
      options,
      criterion: {
        dimension: row.criterionDimension,
        kind: row.criterionKind,
        operator: row.criterionOperator,
        value: row.criterionValue,
      },
    });
    if (!identity) return [];
    return [{
      questionId: row.questionId,
      grantId: row.questionGrantId,
      identity,
      evaluation,
      answerRevision: row.answerRevision,
      answeredAt: row.answeredAt,
    }];
  });
}

function answerMatchesQuestionBinding(
  row: {
    evaluation: string | null;
    evaluationCriterionId: string | null;
    sourceRevisionSha256: string | null;
    sourceRawSha256: string | null;
    questionDefinitionSha256: string | null;
    questionVersion: number | null;
  },
  question: QuestionRow,
): boolean {
  const binding = question.binding;
  return Boolean(
    binding
    && isConfirmationEvaluation(row.evaluation)
    && row.evaluationCriterionId === binding.criterionId
    && row.sourceRevisionSha256 === binding.sourceRevisionSha256
    && row.sourceRawSha256 === binding.sourceRawSha256
    && row.questionDefinitionSha256 === binding.definitionSha256
    && row.questionVersion === binding.questionVersion,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

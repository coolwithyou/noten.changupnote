import { and, asc, eq, isNull } from "drizzle-orm";
import type {
  GrantConfirmationAnswerDto,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
  MatchCard,
} from "@cunote/contracts";
import { toMatchCard } from "@cunote/core";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
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
}): Promise<GrantConfirmationsResult> {
  if (!isUuid(input.grantId)) {
    // DB id 가 없는 공고(샘플 경로)는 질문도 있을 수 없다 — uuid 캐스트 오류 대신 빈 목록.
    return { grantId: input.grantId, questions: [], answers: [] };
  }
  const questions = await loadQuestionRows(input.grantId);
  const answers = questions.length > 0
    ? await loadAnswerDtos({
      companyId: input.companyId,
      grantId: input.grantId,
      questionIds: new Set(questions.map((question) => question.id)),
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
}): Promise<GrantConfirmationSubmitResult> {
  const asOf = input.asOf ?? new Date();
  if (!isUuid(input.grantId)) {
    throw new ConfirmationRequestError(
      "confirmation_questions_not_found",
      "이 공고의 확인 질문이 없습니다.",
      404,
      "grantId",
    );
  }
  const questions = await loadQuestionRows(input.grantId);
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
    throw new ConfirmationRequestError(validation.code, validation.message, 400, "answers");
  }

  const db = getCunoteDb();
  await db.transaction(async (tx) => {
    for (const answer of validation.answers) {
      const row = {
        answer: { values: answer.values },
        disqualified: answer.disqualified,
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
    }
  });

  const saved: GrantConfirmationAnswerDto[] = validation.answers.map((answer) => ({
    questionId: answer.questionId,
    values: answer.values,
    disqualified: answer.disqualified,
    answeredAt: asOf.toISOString(),
  }));
  const recalculated = await recalculateGrantMatch({
    companyId: input.companyId,
    userId: input.userId,
    grantId: input.grantId,
    questionCount: questions.length,
    asOf,
  });
  return { grantId: input.grantId, saved, ...recalculated };
}

/**
 * 저장 직후 해당 공고 1건만 재계산한다. refreshMatchStates 가 확인 답변을 배치 로드해
 * 엔진 입력에 싣고, match_state 쓰기는 company 스코프 프로필일 때만 수행한다
 * (profileQuestionMatchRefresh 의 stateScope 가드와 동일 원칙).
 * 공고를 찾지 못하면 답변 저장은 유지한 채 재계산만 생략한다.
 */
async function recalculateGrantMatch(input: {
  companyId: string;
  userId: string;
  grantId: string;
  questionCount: number;
  asOf: Date;
}): Promise<Pick<GrantConfirmationSubmitResult, "match" | "refresh">> {
  const repositories = getServiceRepositories();
  const [resolution, grant] = await Promise.all([
    resolveProductCompanyProfile({
      context: "owned_read",
      companyId: input.companyId,
      userId: input.userId,
      asOf: input.asOf.toISOString(),
    }),
    repositories.grants.findGrantById(input.grantId, { asOf: input.asOf }),
  ]);
  if (!grant) {
    return { match: null, refresh: { plannedCount: 0, savedCount: 0 } };
  }

  const { plan, savedCount } = await refreshMatchStates({
    repositories,
    companyId: input.companyId,
    company: resolution.profile,
    grants: [grant],
    asOf: input.asOf,
    write: resolution.stateScope === "company",
  });
  const state = plan.states.find((entry) => entry.grantId === input.grantId) ?? plan.states[0];
  if (!state) {
    return { match: null, refresh: { plannedCount: 0, savedCount } };
  }

  const card: MatchCard = toMatchCard({ item: grant, match: state.match }, { asOf: input.asOf });
  const [annotated] = await annotateMatchCardWriteSupport([card]);
  const match: MatchCard = { ...(annotated ?? card), confirmationQuestionCount: input.questionCount };
  return { match, refresh: { plannedCount: plan.states.length, savedCount } };
}

async function loadQuestionRows(grantId: string): Promise<QuestionRow[]> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      id: schema.grantConfirmationQuestions.id,
      prompt: schema.grantConfirmationQuestions.prompt,
      answerType: schema.grantConfirmationQuestions.answerType,
      options: schema.grantConfirmationQuestions.options,
      createdAt: schema.grantConfirmationQuestions.createdAt,
    })
    .from(schema.grantConfirmationQuestions)
    .where(and(
      eq(schema.grantConfirmationQuestions.grantId, grantId),
      isNull(schema.grantConfirmationQuestions.invalidatedAt),
    ))
    .orderBy(
      asc(schema.grantConfirmationQuestions.createdAt),
      asc(schema.grantConfirmationQuestions.id),
    );
  return rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    answerType: normalizeConfirmationAnswerType(row.answerType),
    options: normalizeConfirmationOptions(row.options),
  }));
}

async function loadAnswerDtos(input: {
  companyId: string;
  grantId: string;
  questionIds: ReadonlySet<string>;
}): Promise<GrantConfirmationAnswerDto[]> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      questionId: schema.companyGrantConfirmations.questionId,
      answer: schema.companyGrantConfirmations.answer,
      disqualified: schema.companyGrantConfirmations.disqualified,
      answeredAt: schema.companyGrantConfirmations.answeredAt,
    })
    .from(schema.companyGrantConfirmations)
    .where(and(
      eq(schema.companyGrantConfirmations.companyId, input.companyId),
      eq(schema.companyGrantConfirmations.grantId, input.grantId),
    ));
  return rows
    .filter((row) => input.questionIds.has(row.questionId))
    .map(toConfirmationAnswerDto);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

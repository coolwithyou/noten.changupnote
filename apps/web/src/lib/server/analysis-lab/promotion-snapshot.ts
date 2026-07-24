import { eq } from "drizzle-orm";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import {
  expandConfirmedGrantComponentIds,
  type ConfirmedGrantLinkSnapshot,
} from "../ingestion/grantRevisionInvalidation";
import { sha256Canonical } from "./promotion-release";

export interface PromotionCriterionSnapshot {
  id: string;
  grantId: string;
  dimension: string;
  operator: string;
  value: Record<string, unknown>;
  kind: string;
  weight: number | null;
  confidence: number;
  sourceSpan: string | null;
  rawText: string | null;
  sourceField: string | null;
  stableKey: string | null;
  needsReview: boolean;
  parserVersion: string | null;
}

export interface PromotionQuestionSnapshot {
  id: string;
  grantId: string;
  grantCriteriaId: string | null;
  criterionStableKey: string | null;
  definitionSha256: string;
  version: number;
  supersedesQuestionId: string | null;
  criterionRef: Record<string, unknown> | null;
  prompt: string;
  options: Array<Record<string, unknown>>;
  answerType: string;
  reusable: string;
  conditionKey: string | null;
  promptVer: string;
  provenance: Record<string, unknown>;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  createdAt: string;
}

export interface PromotionAnswerBindingSnapshot {
  questionId: string;
  count: number;
  identitySha256: string;
}

export interface PromotionGrantSnapshot {
  grantId: string;
  criteria: PromotionCriterionSnapshot[];
  questions: PromotionQuestionSnapshot[];
  answerBindings: PromotionAnswerBindingSnapshot[];
  dedupComponentGrantIds: string[];
  dedupLinks: ConfirmedGrantLinkSnapshot[];
}

export interface PromotionGrantSnapshotHashes {
  criteriaSha256: string;
  questionsSha256: string;
  dedupComponentSha256: string;
  snapshotSha256: string;
}

export async function loadPromotionGrantSnapshot(
  db: CunoteDbSession,
  grantId: string,
  confirmedLinks?: ConfirmedGrantLinkSnapshot[],
): Promise<PromotionGrantSnapshot> {
  const links = confirmedLinks ?? await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const componentGrantIds = expandConfirmedGrantComponentIds([grantId], links);
  const componentSet = new Set(componentGrantIds);
  const componentLinks = links
    .filter((link) =>
      componentSet.has(link.canonicalGrantId) && componentSet.has(link.memberGrantId))
    .sort((left, right) =>
      `${left.canonicalGrantId}:${left.memberGrantId}`
        .localeCompare(`${right.canonicalGrantId}:${right.memberGrantId}`));

  const criterionRows = await db
    .select()
    .from(schema.grantCriteria)
    .where(eq(schema.grantCriteria.grantId, grantId));
  const criteria = criterionRows
    .map((row): PromotionCriterionSnapshot => ({ ...row }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const questionRows = await db
    .select()
    .from(schema.grantConfirmationQuestions)
    .where(eq(schema.grantConfirmationQuestions.grantId, grantId));
  const questions = questionRows
    .map((row): PromotionQuestionSnapshot => ({
      ...row,
      invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const answerRows = await db
    .select({
      companyId: schema.companyGrantConfirmations.companyId,
      questionId: schema.companyGrantConfirmations.questionId,
    })
    .from(schema.companyGrantConfirmations)
    .where(eq(schema.companyGrantConfirmations.grantId, grantId));
  const answerIdentitiesByQuestion = new Map<string, string[]>();
  for (const row of answerRows) {
    const identities = answerIdentitiesByQuestion.get(row.questionId) ?? [];
    identities.push(`${row.companyId}:${row.questionId}`);
    answerIdentitiesByQuestion.set(row.questionId, identities);
  }
  const answerBindings = [...answerIdentitiesByQuestion.entries()]
    .map(([questionId, identities]): PromotionAnswerBindingSnapshot => ({
      questionId,
      count: identities.length,
      identitySha256: sha256Canonical(identities.sort()),
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));

  return {
    grantId,
    criteria,
    questions,
    answerBindings,
    dedupComponentGrantIds: componentGrantIds,
    dedupLinks: componentLinks,
  };
}

export function promotionGrantSnapshotHashes(
  snapshot: PromotionGrantSnapshot,
): PromotionGrantSnapshotHashes {
  const criteriaSha256 = sha256Canonical(snapshot.criteria);
  const questionsSha256 = sha256Canonical(snapshot.questions);
  const dedupComponentSha256 = sha256Canonical({
    grantIds: snapshot.dedupComponentGrantIds,
    links: snapshot.dedupLinks,
  });
  return {
    criteriaSha256,
    questionsSha256,
    dedupComponentSha256,
    snapshotSha256: sha256Canonical({
      grantId: snapshot.grantId,
      criteriaSha256,
      questionsSha256,
      dedupComponentSha256,
    }),
  };
}

/**
 * publication drift hash는 사용자가 독립적으로 추가·수정할 수 있는 답변을 제외한다.
 * 답변 binding은 before/after snapshot에 별도 보존하고 verifier가 삭제 여부만 검사한다.
 */
export function promotionGrantSnapshotStateSha256(
  snapshot: PromotionGrantSnapshot,
): string {
  return sha256Canonical({
    grantId: snapshot.grantId,
    criteria: snapshot.criteria,
    activeQuestions: snapshot.questions.filter((question) => question.invalidatedAt === null),
    dedupComponentGrantIds: snapshot.dedupComponentGrantIds,
    dedupLinks: snapshot.dedupLinks,
  });
}

export function snapshotMatchesReleaseBaseline(
  snapshot: PromotionGrantSnapshot,
  baseline: {
    beforeCriteriaSha256: string;
    beforeQuestionsSha256: string;
    dedupComponentSha256: string;
  },
): boolean {
  const hashes = promotionGrantSnapshotHashes(snapshot);
  return hashes.criteriaSha256 === baseline.beforeCriteriaSha256
    && hashes.questionsSha256 === baseline.beforeQuestionsSha256
    && hashes.dedupComponentSha256 === baseline.dedupComponentSha256;
}

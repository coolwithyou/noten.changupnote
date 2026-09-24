import { createHash } from "node:crypto";
import type {
  CriterionDimension,
  CriterionKind,
  GrantConfirmationEvaluation,
} from "@cunote/contracts";

export const COMPANY_FACT_REUSE_CONTRACT_VERSION = "company-fact-reuse-v1" as const;

export interface CompanyFactReuseQuestion {
  questionId: string;
  grantId: string;
  reusable: string;
  conditionKey: string | null;
  evaluationContractVersion: string | null;
  answerType: string;
  options: ReadonlyArray<{
    value: string;
    evaluation?: GrantConfirmationEvaluation;
  }>;
  criterion: {
    dimension: CriterionDimension;
    kind: CriterionKind;
    operator: string;
    value: unknown;
  };
}

export interface CompanyFactReuseIdentity {
  contractVersion: typeof COMPANY_FACT_REUSE_CONTRACT_VERSION;
  conditionKey: string;
  semanticSha256: string;
}

export interface CompanyFactAnswerCandidate {
  questionId: string;
  grantId: string;
  identity: CompanyFactReuseIdentity;
  evaluation: GrantConfirmationEvaluation | "withdrawn";
  answerRevision: number;
  answeredAt: Date;
}

export interface ResolvedCompanyFactAnswer {
  evaluation: GrantConfirmationEvaluation;
  answeredAt: Date;
  sourceQuestionId: string;
  sourceGrantId: string;
  companyFactRevision: string;
}

/**
 * 공고 간 공유 가능한 회사 사실의 의미 경계다. 모델이 만든 conditionKey만 같다고 공유하지 않고,
 * criterion의 종류·연산자·정규화 값(사업장 범위와 기준일 포함)까지 같을 때만 같은 사실로 본다.
 */
export function buildCompanyFactReuseIdentity(
  input: CompanyFactReuseQuestion,
): CompanyFactReuseIdentity | null {
  const conditionKey = input.conditionKey?.normalize("NFC").trim() ?? "";
  if (
    input.reusable !== "company_fact"
    || input.evaluationContractVersion !== "confirmation-evaluation-v2"
    || input.answerType !== "single"
    || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(conditionKey)
  ) return null;

  const evaluations = input.options.flatMap((option) => (
    isConfirmationEvaluation(option.evaluation) ? [option.evaluation] : []
  ));
  if (
    evaluations.length !== input.options.length
    || new Set(evaluations).size !== evaluations.length
    || !evaluations.includes("satisfied")
    || !evaluations.includes("unsatisfied")
    || !evaluations.includes("unknown")
  ) return null;

  const semanticMaterial = {
    contractVersion: COMPANY_FACT_REUSE_CONTRACT_VERSION,
    conditionKey,
    criterion: {
      dimension: input.criterion.dimension,
      kind: input.criterion.kind,
      operator: input.criterion.operator,
      value: canonicalizeSemanticValue(input.criterion.value),
    },
  };
  return {
    contractVersion: COMPANY_FACT_REUSE_CONTRACT_VERSION,
    conditionKey,
    semanticSha256: createHash("sha256")
      .update(stableJson(semanticMaterial))
      .digest("hex"),
  };
}

/** 최신 답변 하나만 투영한다. 같은 시각의 상충 답변은 임의로 고르지 않고 미해소로 둔다. */
export function resolveCompanyFactAnswer(input: {
  identity: CompanyFactReuseIdentity;
  candidates: readonly CompanyFactAnswerCandidate[];
}): ResolvedCompanyFactAnswer | null {
  const compatible = input.candidates
    .filter((candidate) => sameCompanyFactIdentity(candidate.identity, input.identity))
    .sort((left, right) => (
      right.answeredAt.getTime() - left.answeredAt.getTime()
      || right.answerRevision - left.answerRevision
      || right.questionId.localeCompare(left.questionId)
    ));
  const latest = compatible[0];
  if (!latest) return null;

  const sameMoment = compatible.filter((candidate) => (
    candidate.answeredAt.getTime() === latest.answeredAt.getTime()
  ));
  if (new Set(sameMoment.map((candidate) => candidate.evaluation)).size > 1) return null;
  if (latest.evaluation === "withdrawn") return null;

  return {
    evaluation: latest.evaluation,
    answeredAt: latest.answeredAt,
    sourceQuestionId: latest.questionId,
    sourceGrantId: latest.grantId,
    companyFactRevision: companyFactRevision(latest),
  };
}

export function isCompanyFactWithdrawal(raw: unknown): boolean {
  return Boolean(
    raw
    && typeof raw === "object"
    && !Array.isArray(raw)
    && (raw as Record<string, unknown>).withdrawn === true,
  );
}

/** 회사 잠금 안에서 호출한다. 요청 도착 시각/시계 차이로 최신 의사가 과거가 되지 않게 한다. */
export function nextCompanyFactAnswerTime(
  now: Date,
  identity: CompanyFactReuseIdentity,
  candidates: readonly CompanyFactAnswerCandidate[],
): Date {
  return new Date(candidates.reduce((latest, candidate) => (
    sameCompanyFactIdentity(candidate.identity, identity)
      ? Math.max(latest, candidate.answeredAt.getTime() + 1)
      : latest
  ), now.getTime()));
}

export function optionValueForEvaluation(
  question: Pick<CompanyFactReuseQuestion, "options">,
  evaluation: GrantConfirmationEvaluation,
): string | null {
  const matches = question.options.filter((option) => option.evaluation === evaluation);
  return matches.length === 1 ? matches[0]!.value : null;
}

export function sameCompanyFactIdentity(
  left: CompanyFactReuseIdentity,
  right: CompanyFactReuseIdentity,
): boolean {
  return left.contractVersion === right.contractVersion
    && left.conditionKey === right.conditionKey
    && left.semanticSha256 === right.semanticSha256;
}

function companyFactRevision(candidate: CompanyFactAnswerCandidate): string {
  return createHash("sha256").update(stableJson({
    contractVersion: COMPANY_FACT_REUSE_CONTRACT_VERSION,
    conditionKey: candidate.identity.conditionKey,
    semanticSha256: candidate.identity.semanticSha256,
    sourceQuestionId: candidate.questionId,
    answerRevision: candidate.answerRevision,
    answeredAt: candidate.answeredAt.toISOString(),
    evaluation: candidate.evaluation,
  })).digest("hex");
}

function canonicalizeSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...new Set(value.map((item) => item.normalize("NFC")))].sort();
    }
    return value.map(canonicalizeSemanticValue);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.normalize("NFC") : value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const semanticEntries = entries.some(([key]) => key !== "note")
    ? entries.filter(([key]) => key !== "note")
    : entries;
  return Object.fromEntries(semanticEntries.map(([key, item]) => [
    key,
    canonicalizeSemanticValue(item),
  ]));
}

function stableJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isConfirmationEvaluation(value: unknown): value is GrantConfirmationEvaluation {
  return value === "satisfied" || value === "unsatisfied" || value === "unknown";
}

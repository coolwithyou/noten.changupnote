import { INDEPENDENT_REVIEW_AGGREGATE_SCHEMA } from "./independent-review-packet";

export interface IndependentReviewRepairAggregate {
  readonly schema: typeof INDEPENDENT_REVIEW_AGGREGATE_SCHEMA;
  readonly manifestSha256: string;
  readonly launchReceiptSha256: string;
  readonly consensus: {
    readonly defectCount: number;
    readonly unresolvedCount: 0;
    readonly affectedTargets: readonly number[];
  };
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function normalizeIndependentReviewRepairAggregate(
  value: unknown,
): IndependentReviewRepairAggregate {
  const aggregate = object(value, "aggregate");
  const consensus = object(aggregate.consensus, "aggregate.consensus");
  const admission = object(aggregate.admission, "aggregate.admission");
  const policy = object(aggregate.policy, "aggregate.policy");
  if (aggregate.schema !== INDEPENDENT_REVIEW_AGGREGATE_SCHEMA) {
    throw new Error("독립 검수 합의 결함 aggregate schema가 다릅니다.");
  }
  if (
    policy.databaseWrites !== false
    || policy.promotion !== false
    || policy.deployment !== false
  ) {
    throw new Error("독립 검수 aggregate가 읽기 전용 정책으로 봉인되지 않았습니다.");
  }
  if (!Array.isArray(consensus.defects) || !Array.isArray(consensus.unresolved)) {
    throw new Error("독립 검수 aggregate consensus 목록이 없습니다.");
  }
  const defectCount = nonNegativeInteger(consensus.defectCount, "consensus.defectCount");
  const unresolvedCount = nonNegativeInteger(
    consensus.unresolvedCount,
    "consensus.unresolvedCount",
  );
  if (defectCount === 0 || defectCount !== consensus.defects.length) {
    throw new Error("독립 검수 합의 결함 수가 aggregate 목록과 다릅니다.");
  }
  if (unresolvedCount !== consensus.unresolved.length || unresolvedCount !== 0) {
    throw new Error("미합의 판정이 남은 aggregate는 자동 재분석 대상으로 봉인할 수 없습니다.");
  }
  const defectSequences = consensus.defects.map((raw, index) => {
    const finding = object(raw, `consensus.defects[${index}]`);
    if (finding.classification !== "defect") {
      throw new Error("독립 검수 consensus defect 분류가 잘못됐습니다.");
    }
    return nonNegativeInteger(finding.sequence, `consensus.defects[${index}].sequence`);
  });
  const expectedTargets = [...new Set(defectSequences)].sort((left, right) => left - right);
  if (!Array.isArray(consensus.affectedTargets)) {
    throw new Error("독립 검수 consensus affectedTargets가 없습니다.");
  }
  const affectedTargets = consensus.affectedTargets.map((sequence, index) => (
    nonNegativeInteger(sequence, `consensus.affectedTargets[${index}]`)
  ));
  if (
    affectedTargets.length !== expectedTargets.length
    || affectedTargets.some((sequence, index) => sequence !== expectedTargets[index])
  ) {
    throw new Error("독립 검수 합의 결함 대상 sequence가 defect 목록과 다릅니다.");
  }
  if (
    admission.reviewedTargetsStatus !== "HOLD"
    || !Array.isArray(admission.reasons)
    || !admission.reasons.includes(`consensus_defects:${defectCount}`)
  ) {
    throw new Error("독립 검수 합의 결함 aggregate가 HOLD로 봉인되지 않았습니다.");
  }
  return Object.freeze({
    schema: INDEPENDENT_REVIEW_AGGREGATE_SCHEMA,
    manifestSha256: sha(aggregate.manifestSha256, "aggregate.manifestSha256"),
    launchReceiptSha256: sha(
      aggregate.launchReceiptSha256,
      "aggregate.launchReceiptSha256",
    ),
    consensus: Object.freeze({
      defectCount,
      unresolvedCount: 0,
      affectedTargets: Object.freeze(affectedTargets),
    }),
  });
}

export function selectIndependentReviewRepairSequences(
  aggregate: IndependentReviewRepairAggregate,
  requested?: readonly number[],
): readonly number[] {
  if (requested === undefined) return aggregate.consensus.affectedTargets;
  if (
    requested.length === 0
    || new Set(requested).size !== requested.length
    || requested.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)
  ) {
    throw new Error("독립 검수 합의 결함 재분석 sequence는 중복 없는 0 이상의 정수여야 합니다.");
  }
  const allowed = new Set(aggregate.consensus.affectedTargets);
  const selected = [...requested].sort((left, right) => left - right);
  if (selected.some((sequence) => !allowed.has(sequence))) {
    throw new Error("독립 검수 aggregate의 합의 결함 대상이 아닌 sequence는 재분석할 수 없습니다.");
  }
  return Object.freeze(selected);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}가 객체가 아닙니다.`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}가 0 이상의 정수가 아닙니다.`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label}가 SHA-256이 아닙니다.`);
  }
  return value;
}

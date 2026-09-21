/** 오프라인 검수용 v1. 원문을 해석하거나 운영 flat 조건/receipt를 변경하지 않는다. */
export type ConditionExpression =
  | { criterionId: string }
  | { allOf: ConditionExpression[] }
  | { anyOf: ConditionExpression[] };
export type CompoundVerdict = "pass" | "fail" | "unknown";
export interface ReviewedCompoundProjection {
  version: "compound-projection-v1";
  sourceRevisionSha256: string;
  expression: ConditionExpression;
}
export interface CompoundEvaluation {
  result: CompoundVerdict;
  decisiveCriterionIds: string[];
  pendingCriterionIds: string[];
  error?: "invalid_projection" | "source_changed" | "criterion_set_mismatch";
}

/** caller는 current 원문과 대조해 승인한 expression만 넘긴다. 텍스트/LLM 추론 경로는 없다. */
export function evaluateCompoundProjection(projection: ReviewedCompoundProjection, input: {
  sourceRevisionSha256: string;
  /** 필수·제외 조건만 전달한다. 우대/평가 조건은 집합에 포함하지 않는다. */
  criteria: ReadonlyArray<{ id: string; result: CompoundVerdict }>;
}): CompoundEvaluation {
  const rejected = (error: NonNullable<CompoundEvaluation["error"]>): CompoundEvaluation => ({
    result: "unknown", decisiveCriterionIds: [], pendingCriterionIds: [], error,
  });
  if (!projection || projection.version !== "compound-projection-v1") return rejected("invalid_projection");
  if (!/^[a-f0-9]{64}$/.test(input.sourceRevisionSha256) || projection.sourceRevisionSha256 !== input.sourceRevisionSha256) return rejected("source_changed");
  const results = new Map(input.criteria.map((criterion) => [criterion.id, criterion.result]));
  if (!results.size || results.size !== input.criteria.length || input.criteria.some((criterion) => !criterion.id || !["pass", "fail", "unknown"].includes(criterion.result))) return rejected("criterion_set_mismatch");
  const seen = new Set<string>();
  let nodes = 0;
  function evaluate(node: ConditionExpression, depth: number): CompoundEvaluation {
    if (++nodes > 200 || depth > 12 || !node || typeof node !== "object" || Array.isArray(node) || Object.keys(node).length !== 1) throw new Error("invalid_projection");
    if ("criterionId" in node) {
      if (typeof node.criterionId !== "string" || !results.has(node.criterionId) || seen.has(node.criterionId)) throw new Error("criterion_set_mismatch");
      seen.add(node.criterionId);
      const result = results.get(node.criterionId)!;
      return { result, decisiveCriterionIds: result === "unknown" ? [] : [node.criterionId], pendingCriterionIds: result === "unknown" ? [node.criterionId] : [] };
    }
    const isAnd = "allOf" in node;
    const children = isAnd ? node.allOf : "anyOf" in node ? node.anyOf : undefined;
    if (!Array.isArray(children) || children.length === 0) throw new Error("invalid_projection");
    // 모든 분기를 검증한다. pass 경로가 있어도 손상된 다른 분기를 숨기지 않는다.
    const evaluated = children.map((child) => evaluate(child, depth + 1));
    const decisive = evaluated.find((child) => child.result === (isAnd ? "fail" : "pass"));
    if (decisive) return { result: decisive.result, decisiveCriterionIds: decisive.decisiveCriterionIds, pendingCriterionIds: [] };
    const pending = evaluated.flatMap((child) => child.pendingCriterionIds);
    const result = evaluated.some((child) => child.result === "unknown") ? "unknown" : isAnd ? "pass" : "fail";
    return { result, decisiveCriterionIds: evaluated.flatMap((child) => child.decisiveCriterionIds), pendingCriterionIds: pending };
  }
  try {
    const result = evaluate(projection.expression, 0);
    return seen.size === results.size ? result : rejected("criterion_set_mismatch");
  } catch (error) {
    return rejected(error instanceof Error && error.message === "criterion_set_mismatch" ? "criterion_set_mismatch" : "invalid_projection");
  }
}

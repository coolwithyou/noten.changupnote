import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS, type GrantCriterion } from "@cunote/contracts";
import {
  questionCriterionThresholds,
  questionDefinitionFor,
  questionOptions,
} from "./definitions.js";

for (const dimension of CRITERION_DIMENSIONS) {
  const definition = questionDefinitionFor(dimension);
  assert.equal(definition.dimension, dimension);
  assert.match(definition.id, new RegExp(`^profile\\.${dimension}\\.v1$`));
  assert.ok(definition.prompt.length > 0);
}

assert.equal(questionDefinitionFor("revenue").unit, "krw");
assert.equal(questionDefinitionFor("revenue").preciseFollowUp, "when_range_straddles_threshold");
assert.equal(questionDefinitionFor("employees").preciseFollowUp, "when_range_straddles_threshold");
assert.equal(questionDefinitionFor("tax_compliance").responsePolicy, "tri_state_no_default");

const revenueCriteria: GrantCriterion[] = [
  criterion("gte", { min_krw: 100_000_000 }),
  criterion("gte", { min_krw: 100_000_000 }),
  criterion("lte", { max_krw: 500_000_000 }),
];
assert.deepEqual(questionCriterionThresholds("revenue", [
  { grantId: "grant-1", criterion: revenueCriteria[0]! },
  { grantId: "grant-2", criterion: revenueCriteria[1]! },
  { grantId: "grant-3", criterion: revenueCriteria[2]! },
]), [
  { field: "min_krw", operator: "gte", value: 100_000_000, unit: "krw", affectedGrantCount: 2 },
  { field: "max_krw", operator: "lte", value: 500_000_000, unit: "krw", affectedGrantCount: 1 },
]);

const priorAwardOptions = questionOptions(questionDefinitionFor("prior_award"), [
  criterion("in", { programs: ["청년창업사관학교"] }, "prior_award"),
]);
assert.deepEqual(priorAwardOptions, ["해당 없음", "청년창업사관학교"]);

console.log("questions/definitions.test.ts: all assertions passed");

function criterion(
  operator: GrantCriterion["operator"],
  value: Record<string, unknown>,
  dimension: GrantCriterion["dimension"] = "revenue",
): GrantCriterion {
  return {
    dimension,
    operator,
    kind: "required",
    confidence: 0.9,
    source_span: "fixture",
    value,
  };
}

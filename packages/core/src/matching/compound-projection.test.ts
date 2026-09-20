import assert from "node:assert/strict";
import { evaluateCompoundProjection, type CompoundVerdict, type ConditionExpression } from "./compound-projection.js";
const sha = "a".repeat(64);
const leaf = (criterionId: string): ConditionExpression => ({ criterionId });
function evaluate(expression: ConditionExpression, values: CompoundVerdict[], source = sha) {
  return evaluateCompoundProjection({ version: "compound-projection-v1", sourceRevisionSha256: sha, expression }, {
    sourceRevisionSha256: source, criteria: values.map((result, i) => ({ id: String(i), result })),
  });
}
const states: CompoundVerdict[] = ["pass", "fail", "unknown"];
for (const a of states) for (const b of states) {
  assert.equal(evaluate({ anyOf: [leaf("0"), leaf("1")] }, [a, b]).result, a === "pass" || b === "pass" ? "pass" : a === "fail" && b === "fail" ? "fail" : "unknown");
  assert.equal(evaluate({ allOf: [leaf("0"), leaf("1")] }, [a, b]).result, a === "fail" || b === "fail" ? "fail" : a === "pass" && b === "pass" ? "pass" : "unknown");
}
// 분야 AND (GBC OR 유럽 진출 희망): 합성 의미 fixture, 실제 원문 승인 artifact가 아님.
const nested = { allOf: [leaf("0"), { anyOf: [leaf("1"), leaf("2")] }] };
assert.deepEqual(evaluate(nested, ["pass", "unknown", "pass"]), { result: "pass", decisiveCriterionIds: ["0", "2"], pendingCriterionIds: [] });
assert.equal(evaluate(nested, ["unknown", "pass", "fail"]).result, "unknown");
assert.equal(evaluate(nested, ["fail", "pass", "pass"]).result, "fail");
for (const expression of [{ anyOf: [] }, { allOf: [] }, { anyOf: [leaf("0"), { allOf: [] }] }]) {
  assert.equal(evaluate(expression, ["pass"]).error, "invalid_projection");
}
assert.equal(evaluate({ anyOf: [leaf("0"), leaf("0")] }, ["pass"]).error, "criterion_set_mismatch");
assert.equal(evaluate(leaf("0"), ["pass", "fail"]).error, "criterion_set_mismatch");
assert.equal(evaluate(leaf("0"), ["pass"], "b".repeat(64)).error, "source_changed");
console.log("compound projection: 18 truth table cases, nested alternatives, omitted/duplicate criteria and revision drift passed");

import assert from "node:assert/strict";
import {
  APPLICATION_FIELD_PARSER_VERSION,
  classifyApplicationFieldMap,
} from "./applicationFieldVersion";

assert.equal(classifyApplicationFieldMap([]), "empty");
assert.equal(classifyApplicationFieldMap([APPLICATION_FIELD_PARSER_VERSION]), "current_automated");
assert.equal(classifyApplicationFieldMap(["kordoc-rhwp-application-fields-v1"]), "stale_automated");
assert.equal(classifyApplicationFieldMap(["kordoc-rhwp-application-fields-v2"]), "stale_automated");
assert.equal(classifyApplicationFieldMap(["reconcile-v0"]), "protected");
assert.equal(
  classifyApplicationFieldMap(["reconcile-v0", "kordoc-rhwp-application-fields-v1"]),
  "protected",
  "사람 검수 필드가 섞인 surface는 자동 재분석으로 덮어쓰면 안 된다",
);

console.log("application field version tests: ok");

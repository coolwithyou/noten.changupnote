import assert from "node:assert/strict";
import {
  DocumentAgentUnavailableError,
  isDocumentAgentFeatureEnabled,
  resolveDocumentAgentAvailability,
} from "./documentAgentAvailability";

assert.equal(isDocumentAgentFeatureEnabled("true"), true);
assert.equal(isDocumentAgentFeatureEnabled(" 1 "), true);
assert.equal(isDocumentAgentFeatureEnabled("TRUE"), true);
assert.equal(isDocumentAgentFeatureEnabled("yes"), false);
assert.equal(isDocumentAgentFeatureEnabled(undefined), false);

assert.equal(resolveDocumentAgentAvailability({
  executionMode: "persistent",
  role: "member",
  draftId: "draft",
  featureFlag: "true",
}), true);
assert.equal(resolveDocumentAgentAvailability({
  executionMode: "persistent",
  role: "viewer",
  draftId: "draft",
  featureFlag: "true",
}), false);
assert.equal(resolveDocumentAgentAvailability({
  executionMode: "virtual_preview",
  role: "owner",
  draftId: "draft",
  featureFlag: "true",
}), false);
assert.equal(resolveDocumentAgentAvailability({
  executionMode: "persistent",
  role: "owner",
  draftId: null,
  featureFlag: "true",
}), false);
assert.equal(resolveDocumentAgentAvailability({
  executionMode: "persistent",
  role: "owner",
  draftId: "draft",
}), false);
assert.equal(new DocumentAgentUnavailableError().status, 404);

console.log("document agent availability tests passed");

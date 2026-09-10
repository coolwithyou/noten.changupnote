import assert from "node:assert/strict";
import { commitStudioSnapshot, isStudioMutationScopeCurrent } from "./studioTransport";

let persistCalls = 0;
const local = await commitStudioSnapshot({
  transport: {
    mode: "local_preview",
    sourceKey: "virtual:grant:biz:document",
    sourceUrl: "/api/virtual-source",
  },
  persist: async () => {
    persistCalls += 1;
    return { revisionId: "must-not-exist" };
  },
});
assert.deepEqual(local, { mode: "local_preview" });
assert.equal(persistCalls, 0, "가상 기업 로컬 편집은 서버 persist 콜백을 호출하면 안 됩니다.");

const persistent = await commitStudioSnapshot({
  transport: { mode: "persistent", draftId: "draft-1" },
  persist: async (draftId) => {
    persistCalls += 1;
    return { revisionId: `revision-for-${draftId}` };
  },
});
assert.deepEqual(persistent, {
  mode: "persistent",
  value: { revisionId: "revision-for-draft-1" },
});
assert.equal(persistCalls, 1, "기존 persistent 경로는 persist 콜백을 정확히 한 번 호출해야 합니다.");

const expectedScope = { sourceKey: "draft:draft-1", sessionId: "session-1", requestSeq: 3 };
assert.equal(isStudioMutationScopeCurrent(expectedScope, { ...expectedScope }), true);
assert.equal(isStudioMutationScopeCurrent(expectedScope, { ...expectedScope, sourceKey: "draft:draft-2" }), false);
assert.equal(isStudioMutationScopeCurrent(expectedScope, { ...expectedScope, sessionId: "session-2" }), false);
assert.equal(isStudioMutationScopeCurrent(expectedScope, { ...expectedScope, requestSeq: 4 }), false);
assert.equal(isStudioMutationScopeCurrent(expectedScope, { ...expectedScope, sourceKey: null }), false);

let currentScope = { ...expectedScope };
let staleCallbackCount = 0;
let releaseDelayedResponse!: () => void;
const delayedResponse = new Promise<void>((resolve) => {
  releaseDelayedResponse = resolve;
});
const consumeDelayedResponse = delayedResponse.then(() => {
  if (isStudioMutationScopeCurrent(expectedScope, currentScope)) staleCallbackCount += 1;
});
currentScope = { ...currentScope, sourceKey: "draft:draft-2", requestSeq: 4 };
releaseDelayedResponse();
await consumeDelayedResponse;
assert.equal(staleCallbackCount, 0, "문서 전환 뒤 도착한 지연 응답은 새 문서 callback을 실행하면 안 됩니다.");

console.log("rhwp studio transport persistence boundary passed");

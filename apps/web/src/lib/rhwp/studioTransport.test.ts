import assert from "node:assert/strict";
import { commitStudioSnapshot } from "./studioTransport";

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

console.log("rhwp studio transport persistence boundary passed");

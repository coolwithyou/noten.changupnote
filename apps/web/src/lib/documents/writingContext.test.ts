import assert from "node:assert/strict";
import { createWritingSourceSchema, emptyWritingBrief, saveWritingBriefSchema } from "./writingContext";
const source = { requestId: crypto.randomUUID(), title: "회사 자료", content: "2025년 실적\n2027년 목표", kind: "user_statement", scope: "application", observedDate: null };
assert.equal(createWritingSourceSchema.parse(source).content, source.content);
for (const change of [{ title: " " }, { content: "" }, { content: "x".repeat(30001) }, { scope: "public" }, { kind: "verified" }, { observedDate: "2026-02-30" }, { content: "bad\u0000" }, { companyId: crypto.randomUUID() }]) {
  assert.equal(createWritingSourceSchema.safeParse({ ...source, ...change }).success, false);
}
const brief = { expectedRevision: 0, brief: emptyWritingBrief(), sourceIds: [] };
assert.equal(saveWritingBriefSchema.safeParse(brief).success, true);
assert.equal(saveWritingBriefSchema.safeParse({ ...brief, expectedRevision: -1 }).success, false);
assert.equal(saveWritingBriefSchema.safeParse({ ...brief, sourceIds: [source.requestId, source.requestId] }).success, false);
assert.equal(saveWritingBriefSchema.safeParse({ ...brief, sourceIds: Array.from({ length: 11 }, () => crypto.randomUUID()) }).success, false);
console.log("PASS: writing input preserves multiline text, permits unknown plans, bounds content and rejects invalid provenance/scope/source selection");

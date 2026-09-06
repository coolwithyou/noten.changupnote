import assert from "node:assert/strict";
import { clearProfileDraft, readProfileDraft, writeProfileDraft } from "./profileDraft";
const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => { entries.set(key, value); },
  removeItem: (key: string) => { entries.delete(key); },
};
const bizNo = "1234567890";
const now = Date.parse("2026-09-06T00:00:00Z");
const answers = [{ field: "employees", value: 0 }, { field: "certification", value: [] }, { field: "size", unknown: true }] as const;
assert.equal(writeProfileDraft(storage, bizNo, answers, now), true);
assert.deepEqual(readProfileDraft(storage, bizNo, now + 1), answers);
assert.deepEqual(readProfileDraft(storage, "9999999999", now), [], "다른 사업자의 답변은 섞이지 않는다");
assert.deepEqual(readProfileDraft(storage, bizNo, now + 86_400_000), [], "24시간 뒤에는 자동 재사용하지 않는다");
assert.equal(entries.size, 0);
assert.equal(writeProfileDraft(null, bizNo, answers, now), false);
assert.equal(writeProfileDraft(storage, "bad", answers, now), false);
const broken = { ...storage, getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
assert.deepEqual(readProfileDraft(broken, bizNo, now), []);
assert.equal(writeProfileDraft(broken, bizNo, answers, now), false);
writeProfileDraft(storage, bizNo, answers, now);
const key = [...entries.keys()][0]!;
for (const value of ["{", "null", JSON.stringify({ version: 1, bizNo, savedAt: now, answers: [{ field: "invented", value: 1 }] })]) {
  entries.set(key, value);
  assert.deepEqual(readProfileDraft(storage, bizNo, now), []);
}
writeProfileDraft(storage, bizNo, answers, now);
clearProfileDraft(storage, bizNo);
assert.deepEqual(readProfileDraft(storage, bizNo, now), []);
console.log("profile draft resume: ok");

import assert from "node:assert/strict";
import type { TeaserRequest } from "@cunote/contracts";
import { companyResumeLoginPath, PENDING_TEASER_STORAGE_KEY as KEY, readPendingCompanyRequest, resumePendingCompanySave, savedCompanyDestination, savePendingCompanyRequest } from "./companySaveHandoff";

class StorageFixture {
  values = new Map<string, string>();
  failWrite = false;
  failRemove = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrite) throw new Error("storage unavailable"); this.values.set(key, value); }
  removeItem(key: string) { if (this.failRemove) throw new Error("storage unavailable"); this.values.delete(key); }
}
const request: TeaserRequest = { bizNo: "7465400870", answers: [
  { field: "employees", value: 0 }, { field: "certification", value: [] }, { field: "industry", unknown: true },
] };
const target = { grantId: "grant/1", next: "/matches?biz=7465400870&confirm=grant-1#profile" };
const success = () => new Response(JSON.stringify({ ok: true, data: { currentCompanyId: "company-a" } }), { status: 201 });
function prepared() { const storage = new StorageFixture(); assert.equal(savePendingCompanyRequest(storage, request), true); return storage; }

assert.equal(savePendingCompanyRequest(null, request), false);
assert.equal(savePendingCompanyRequest(new StorageFixture(), { bizNo: "bad" }), false);
assert.equal(savedCompanyDestination("company-a"), "/matches?companyId=company-a#profile");
assert.equal(savedCompanyDestination("company-a", target), "/matches?confirm=grant-1&companyId=company-a#profile");
assert.equal(savedCompanyDestination("company-a", { next: "//external.test", grantId: "grant/1" }), "/grants/grant%2F1?companyId=company-a");
const callback = new URL(companyResumeLoginPath(target), "https://local.test").searchParams.get("callbackUrl")!;
const callbackQuery = new URL(callback, "https://local.test").searchParams;
assert.equal(callbackQuery.get("resumeNext"), target.next);
assert.equal(callbackQuery.get("resumeGrant"), target.grantId);

const storage = prepared();
let calls = 0;
let finish!: (response: Response) => void;
let started!: () => void;
const requestStarted = new Promise<void>((resolve) => { started = resolve; });
const delayed: typeof fetch = async (_url, init) => {
  calls++;
  assert.deepEqual(JSON.parse(String(init?.body)), request);
  assert.equal(JSON.parse(storage.getItem(KEY)!).state, "sending");
  assert.deepEqual(readPendingCompanyRequest(storage), request, "응답 전에 입력을 삭제하지 않는다");
  return new Promise<Response>((resolve) => { finish = resolve; started(); });
};
const first = resumePendingCompanySave(storage, target, delayed);
const concurrent = resumePendingCompanySave(storage, target, delayed);
assert.equal(first, concurrent, "동시 effect는 같은 요청을 공유한다");
await requestStarted;
finish(success());
assert.equal((await first).status, "saved");
assert.equal(calls, 1);
assert.equal(storage.getItem(KEY), null);

const unauthorized = prepared();
const login = await resumePendingCompanySave(unauthorized, target, async () => new Response(null, { status: 401 }));
assert.equal(login.status, "login");
assert.deepEqual(readPendingCompanyRequest(unauthorized), request);
assert.equal(JSON.parse(unauthorized.getItem(KEY)!).state, "pending");
assert.equal((await resumePendingCompanySave(unauthorized, target, async () => success())).status, "saved");

const rejected = prepared();
const rejection = await resumePendingCompanySave(rejected, target, async () => new Response(JSON.stringify({ ok: false, error: { message: "입력 확인 필요" } }), { status: 400 }));
assert.equal(rejection.status, "failed");
assert.deepEqual(readPendingCompanyRequest(rejected), request);
assert.equal(JSON.parse(rejected.getItem(KEY)!).state, "pending");

for (const fetcher of [
  async () => { throw new DOMException("timeout", "TimeoutError"); },
  async () => new Response("failed", { status: 500 }),
  async () => new Response(JSON.stringify({ ok: false }), { status: 503 }),
  async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 201 }),
] satisfies Array<typeof fetch>) {
  const uncertain = prepared();
  assert.equal((await resumePendingCompanySave(uncertain, {}, fetcher)).status, "uncertain");
  assert.deepEqual(readPendingCompanyRequest(uncertain), request);
  assert.equal((await resumePendingCompanySave(uncertain, {}, async () => { assert.fail("응답 유실 후 자동 재생성 금지"); })).status, "uncertain");
}
const interrupted = prepared();
interrupted.setItem(KEY, JSON.stringify({ ...JSON.parse(interrupted.getItem(KEY)!), state: "sending" }));
assert.equal((await resumePendingCompanySave(interrupted, {}, async () => { assert.fail("새로고침 중단 후 자동 재생성 금지"); })).status, "uncertain");

const blockedStorage = prepared();
blockedStorage.failWrite = true;
assert.equal((await resumePendingCompanySave(blockedStorage, {}, async () => { assert.fail("보관 실패 시 서버 쓰기 금지"); })).status, "failed");
const failedRemoval = prepared();
failedRemoval.failRemove = true;
assert.equal((await resumePendingCompanySave(failedRemoval, {}, async () => success())).status, "saved");
assert.equal(JSON.parse(failedRemoval.getItem(KEY)!).state, "saved");
assert.equal((await resumePendingCompanySave(failedRemoval, target, async () => { assert.fail("이동만 재개, 회사 재생성 금지"); })).status, "saved");

const legacy = new StorageFixture();
legacy.setItem(KEY, JSON.stringify(request));
assert.deepEqual(readPendingCompanyRequest(legacy), request);
assert.equal((await resumePendingCompanySave(legacy, {}, async () => success())).status, "saved");
for (const raw of ["{broken", "[]", "null", JSON.stringify({ bizNo: 7465400870 }), "x".repeat(100_001)]) {
  const invalid = new StorageFixture(); invalid.setItem(KEY, raw);
  assert.equal((await resumePendingCompanySave(invalid, {}, async () => { assert.fail("손상 요청은 실행하지 않는다"); })).status, "missing");
}
const expired = prepared();
expired.setItem(KEY, JSON.stringify({ ...JSON.parse(expired.getItem(KEY)!), createdAt: Date.now() - 25 * 60 * 60 * 1_000 }));
assert.equal(readPendingCompanyRequest(expired), null);

const replaced = prepared();
const replacement = { bizNo: "1234567890" };
const replacedResult = await resumePendingCompanySave(replaced, {}, async () => {
  savePendingCompanyRequest(replaced, replacement);
  return success();
});
assert.equal(replacedResult.status, "uncertain");
assert.deepEqual(readPendingCompanyRequest(replaced), replacement, "오래된 성공 응답이 새 대기 요청을 지우지 않는다");
console.log("company save handoff: preservation, uncertainty, single-flight, legacy and destinations passed");

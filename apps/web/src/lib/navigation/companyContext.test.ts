import assert from "node:assert/strict";
import { companyScopedFetch, COMPANY_CONTEXT_HEADER, withCompanyContext } from "./companyContext";
import { requestCompanyScope } from "../server/auth/requestCompanyScope";

assert.equal(withCompanyContext("/matches?biz=123&confirm=grant#profile", "a"), "/matches?confirm=grant&companyId=a#profile");
assert.equal(withCompanyContext("/grants/g/workspace?document=form", "a"), "/grants/g/workspace?document=form&companyId=a");
assert.throws(() => withCompanyContext("https://outside.test/", "a"));
for (const value of [null, "", " a", [], ["a", "b"]]) assert.throws(() => requestCompanyScope(value));
assert.deepEqual(requestCompanyScope(undefined), {});
assert.deepEqual(requestCompanyScope("a"), { companyId: "a" });

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
const calls: RequestInit[] = [];
globalThis.fetch = async (_input, init) => { calls.push(init ?? {}); return new Response(); };
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://local.test/grants/g/workspace?companyId=a" } } });
try {
  await companyScopedFetch("/api/web/document-drafts/d/download", { headers: { accept: "application/json" }, method: "POST" });
  assert.equal(new Headers(calls.at(-1)?.headers).get(COMPANY_CONTEXT_HEADER), "a");
  assert.equal(new Headers(calls.at(-1)?.headers).get("accept"), "application/json");
  assert.equal(calls.at(-1)?.method, "POST");
  await companyScopedFetch("https://outside.test/api/web/document-drafts/d");
  assert.equal(new Headers(calls.at(-1)?.headers).has(COMPANY_CONTEXT_HEADER), false);
  await companyScopedFetch("/assets/template.hwp");
  assert.equal(new Headers(calls.at(-1)?.headers).has(COMPANY_CONTEXT_HEADER), false);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://local.test/grants/g/workspace?companyId=" } } });
  await companyScopedFetch("/api/web/document-drafts/d");
  assert.equal(new Headers(calls.at(-1)?.headers).get(COMPANY_CONTEXT_HEADER), "", "빈 명시적 문맥도 서버에서 거부하도록 유지");
} finally {
  globalThis.fetch = originalFetch;
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
}
console.log("company context: navigation, scope validation and same-origin API binding passed");

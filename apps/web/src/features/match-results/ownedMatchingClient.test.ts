import assert from "node:assert/strict";
import type { OwnedCompanyMatchingResult } from "@cunote/contracts";
import { loadOwnedMatching, saveOwnedMatchingAnswer } from "./ownedMatchingClient";

const originalFetch = globalThis.fetch;
const matching = { companyId: "company-a", teaser: {}, unknownDimensions: ["industry"] } as OwnedCompanyMatchingResult;
const requests: Array<{ url: string; init?: RequestInit }> = [];
let body: unknown = { ok: true, data: matching };
let status = 200;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), ...(init ? { init } : {}) });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};
try {
  assert.deepEqual(await loadOwnedMatching(), matching);
  assert.equal(requests.at(-1)?.url, "/api/web/company-matching");
  assert.equal(requests.at(-1)?.init?.cache, "no-store");
  await loadOwnedMatching("company-a");
  assert.equal(requests.at(-1)?.url, "/api/web/company-matching?companyId=company-a");
  await assert.rejects(() => loadOwnedMatching("company-b"), { code: "company_scope_mismatch" });
  body = { ok: true, data: { matching } };
  await saveOwnedMatchingAnswer("company-a", { field: "industry", unknown: true });
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { companyId: "company-a", field: "industry", unknown: true });
  assert.equal(requests.at(-1)?.url, "/api/web/profile/field");
  await assert.rejects(() => saveOwnedMatchingAnswer("company-b", { field: "employees", value: 0 }), { code: "company_scope_mismatch" });
  status = 403;
  body = { ok: false, error: { code: "company_forbidden", message: "회사 접근 불가" } };
  await assert.rejects(() => saveOwnedMatchingAnswer("company-a", { field: "certification", value: [] }), { code: "company_forbidden" });
  status = 401;
  body = { ok: false, error: { code: "auth_required", message: "로그인 필요" } };
  await assert.rejects(() => loadOwnedMatching("company-a"), { code: "auth_required" });
  assert.ok(requests.every((request) => !request.url.includes("/teaser") && !request.url.endsWith("/companies")), "실패해도 익명 재조회나 회사 생성으로 후퇴하지 않는다");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("owned matching client: exact company, cache policy and failure preservation passed");

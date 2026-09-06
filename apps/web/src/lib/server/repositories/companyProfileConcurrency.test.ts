import assert from "node:assert/strict";
import { assertCompanyProfileUnchanged, companyProfileRevision, matchingProfileRevision } from "./companyProfileConcurrency";
import { createRuntimeRepositories, demoCompanyId } from "./runtime";

const original = { employees_count: 0, certs: [] };
assert.equal(companyProfileRevision(original), companyProfileRevision({ certs: [], employees_count: 0 }));
assert.notEqual(companyProfileRevision(original), companyProfileRevision({ certs: [] }));
assert.throws(() => assertCompanyProfileUnchanged({ employees_count: 1 }, original), { code: "company_profile_conflict", status: 409 });
assertCompanyProfileUnchanged(original, original);
assert.notEqual(matchingProfileRevision({ revenue_krw: 100_000_000 }), matchingProfileRevision({ revenue_krw: 100_000_001 }), "화면에서 같은 억 단위로 반올림돼도 원시 사실 변경은 충돌이다");
assert.notEqual(matchingProfileRevision({ question_answer_state: { revenue: { status: "range", min: 0, max: 1, unit: "krw", answeredAt: "2026-09-06T00:00:00Z", expiresAt: "2026-10-06T00:00:00Z", sourceKind: "self_declared", rulesetVer: null } } }), matchingProfileRevision({}), "구간 답변 원문도 버전에 포함한다");

const repo = createRuntimeRepositories({ loadGrants: async () => [], loadCompanyProfile: async () => structuredClone(original) });
const id = demoCompanyId();
const userId = "user-concurrency";
const before = await repo.companies.resolveCompanyProfile({ companyId: id, userId });
assert.ok(before);
const writes = await Promise.allSettled([
  repo.companies.saveCompanyProfile({ companyId: id, userId, expectedProfile: before, profile: { ...before, employees_count: 1 } }),
  repo.companies.saveCompanyProfile({ companyId: id, userId, expectedProfile: before, profile: { ...before, employees_count: 2 } }),
]);
assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
const persisted = await repo.companies.resolveCompanyProfile({ companyId: id, userId });
assert.equal(persisted?.employees_count, 1);
assert.deepEqual(persisted?.certs, []);
console.log("profile concurrency: stale read rejected, one concurrent write preserved (runtime adapter)");

import assert from "node:assert/strict";
import { createDrizzleRepositories, decodeCompanyProfileRows, encodeCompanyProfileRows, type CompanyProfilePersistenceRow } from "./drizzle";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";

// 실제 Drizzle adapter의 트랜잭션 순서를 검증한다. 실제 Postgres 잠금/unique 대기 검증은 별도 UAT다.
const company = { id: "00000000-0000-8000-8000-000000000123", kind: "active" as const, name: "검증 회사", createdBy: "user-a", verified: false, verifiedAt: null, verifyMethod: null, bizNo: null };
const rows = encodeCompanyProfileRows(company.id, { employees_count: 0 }, new Date("2026-09-06T00:00:00Z"), "user-a") as CompanyProfilePersistenceRow[];
const current = decodeCompanyProfileRows(company, rows);
const events: string[] = [];
let permitReplay = true;
const tx = {
  execute: async () => { events.push("user-context"); },
  select: () => {
    let table: unknown;
    let joined = false;
    const chain = {
      from(value: unknown) { table = value; return chain; },
      innerJoin() { joined = true; return chain; },
      where() { return chain; },
      limit() { return chain; },
      for(mode: string) { events.push(`lock:${mode}`); return Promise.resolve([company]); },
      then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
        events.push(table === schema.companyProfiles ? "read-profile" : "read-company");
        return Promise.resolve(table === schema.companyProfiles ? rows : joined ? (permitReplay ? [{ company }] : []) : [company]).then(resolve, reject);
      },
    };
    return chain;
  },
  insert: (table: unknown) => {
    const chain = {
      values(values: unknown) { events.push(table === schema.companies ? "insert-company" : "insert-profile"); return chain; },
      onConflictDoNothing() { events.push("unique-replay-gate"); return chain; },
      returning: async () => table === schema.companies ? [] : rows,
    };
    return chain;
  },
  update: () => { events.push("update"); const chain = { set: () => chain, where: () => chain, returning: async () => [company] }; return chain; },
  delete: () => { events.push("delete"); return { where: async () => undefined }; },
};
const fakeDb = { transaction: async (run: (session: typeof tx) => Promise<unknown>) => {
  events.push("begin");
  try { const result = await run(tx); events.push("commit"); return result; }
  catch (error) { events.push("rollback"); throw error; }
} };
const repository = createDrizzleRepositories({ dialect: "drizzle", client: fakeDb as unknown as CunoteDb }).companies;
await assert.rejects(() => repository.saveCompanyProfile({ companyId: company.id, userId: "user-a", profile: { employees_count: 99 }, expectedProfile: { ...current, employees_count: 7 } }), { code: "company_profile_conflict" });
assert.deepEqual(events, ["begin", "user-context", "lock:update", "read-profile", "rollback"]);
events.length = 0;
await repository.saveCompanyProfile({ companyId: company.id, userId: "user-a", profile: current, expectedProfile: current });
assert.ok(events.indexOf("lock:update") < events.indexOf("update"));
assert.ok(events.indexOf("read-profile") < events.indexOf("delete"));
assert.equal(events.at(-1), "commit");
events.length = 0;
const replay = await repository.createCompany({ userId: "user-a", creationId: company.id, profile: { employees_count: 999 } });
assert.equal(replay.id, company.id);
assert.equal(replay.profile.employees_count, 0);
assert.ok(events.includes("unique-replay-gate"));
assert.ok(!events.some((event) => ["update", "delete", "insert-profile"].includes(event)));
permitReplay = false;
await assert.rejects(() => repository.createCompany({ userId: "user-a", creationId: company.id, profile: {} }), { code: "company_create_replay_forbidden", status: 403 });
assert.equal(events.at(-1), "rollback");
console.log("company writes: Drizzle CAS ordering, rollback, non-overwriting replay and replay ownership passed (fake transaction)");

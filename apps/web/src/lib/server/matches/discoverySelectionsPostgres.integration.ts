import assert from "node:assert/strict";
import type postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import { closeCunoteDb } from "../db/client";
import { loadDiscoverySelections, saveDiscoverySelection } from "./discoverySelections";

export async function verifyDiscoverySelectionsPostgres(input: { admin: postgres.Sql; client: postgres.Sql; socket: string; access: CompanyAccess }) {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);
  await closeCunoteDb();
  const keys = ["DATABASE_URL", "PGHOST", "PGUSER"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.DATABASE_URL = "postgres:///postgres"; process.env.PGHOST = input.socket; process.env.PGUSER = "postgres";
  try {
    const { admin, client, access } = input;
    const grantId = crypto.randomUUID();
    await admin`insert into grants(id,source,source_id,title,status,apply_end,overall_confidence)
      values (${grantId},'bizinfo',${grantId},'복원 검증 공고','open',now()+interval '10 days',1)`;
    assert.deepEqual((await loadDiscoverySelections(access)).selections, []);
    const body = { grantId, restored: true, expectedRevision: 0 };
    const results = await Promise.allSettled([saveDiscoverySelection(access, body), saveDiscoverySelection(access, body)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "discovery_selection_conflict");
    assert.deepEqual((await loadDiscoverySelections(access)).selections, [{ grantId, restored: true, revision: 1 }]);
    await saveDiscoverySelection(access, { ...body, restored: false, expectedRevision: 1 });
    await assert.rejects(() => saveDiscoverySelection(access, { ...body, expectedRevision: 1 }), { status: 409 });
    const stranger = crypto.randomUUID(); const otherCompany = crypto.randomUUID();
    await admin`insert into users(id,email) values (${stranger},${`${stranger}@example.invalid`})`;
    await admin`insert into companies(id,name,kind,created_by) values (${otherCompany},'다른 회사','active',${stranger})`;
    await admin`insert into user_company(user_id,company_id,role) values (${stranger},${otherCompany},'owner')`;
    const otherAccess = { ...access, userId: stranger, companyId: otherCompany };
    assert.deepEqual((await loadDiscoverySelections(otherAccess)).selections, []);
    await saveDiscoverySelection(otherAccess, body);
    assert.equal((await loadDiscoverySelections(access)).selections[0]!.restored, false);
    await assert.rejects(() => loadDiscoverySelections({ ...access, userId: stranger }), { status: 403 });
    await admin`insert into user_company(user_id,company_id,role) values (${stranger},${access.companyId},'viewer')`;
    assert.equal((await loadDiscoverySelections({ ...access, userId: stranger })).canWrite, false);
    await assert.rejects(() => saveDiscoverySelection({ ...access, userId: stranger }, { ...body, expectedRevision: 2 }), { status: 403 });
    await assert.rejects(() => saveDiscoverySelection({ ...access, mode: 'demo' }, body), { status: 403 });
    await admin`delete from user_company where user_id=${stranger} and company_id=${access.companyId}`;
    const hidden = await client.begin(async (tx) => {
      await tx`select set_config('app.current_user_id',${stranger},true)`;
      return tx`select * from company_discovery_selections where company_id=${access.companyId}`;
    });
    assert.equal(hidden.length, 0);
    await assert.rejects(() => client.begin(async (tx) => {
      await tx`select set_config('app.current_user_id',${stranger},true)`;
      await tx`insert into company_discovery_selections(company_id,grant_id,restored,revision,updated_by)
        values (${access.companyId},${grantId},true,99,${stranger})`;
    }));
    await admin`update grants set apply_end=now()-interval '1 second' where id=${grantId}`;
    await assert.rejects(() => saveDiscoverySelection(access, { ...body, expectedRevision: 2 }), { code: "discovery_grant_closed" });
    await admin`update grants set apply_end=now()+interval '10 days', status='closed' where id=${grantId}`;
    await assert.rejects(() => saveDiscoverySelection(access, { ...body, expectedRevision: 2 }), { code: "discovery_grant_closed" });
    // 복원 취소는 마감 후에도 가능하고 작성본/적격성 데이터는 건드리지 않는다.
    await saveDiscoverySelection(otherAccess, { ...body, restored: false, expectedRevision: 1 });
    await admin`update grants set serving_state='suppressed' where id=${grantId}`;
    await assert.rejects(() => saveDiscoverySelection(access, { ...body, expectedRevision: 2 }), { status: 404 });
    console.log("Discovery selections PostgreSQL: CAS, tenant isolation, RLS, live role, deadline PASS");
  } finally {
    await closeCunoteDb();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
}

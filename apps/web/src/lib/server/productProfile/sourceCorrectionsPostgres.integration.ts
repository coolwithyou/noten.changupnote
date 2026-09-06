import assert from "node:assert/strict";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { createSourceCorrection, listSourceCorrections, updateOwnSourceCorrection } from "./sourceCorrections";
import type { CompanyAccess } from "../auth/companyGuard";
import type { CompanyProfile } from "@cunote/contracts";

export async function verifySourceCorrectionsPostgres(input: { admin: postgres.Sql; client: postgres.Sql; access: CompanyAccess; otherId: string }) {
  const db = drizzle(input.admin, { schema });
  const profile: CompanyProfile = { employees_count: 20, profile_evidence: { employees: { sourceKind: "authoritative_api", provider: "fixture_official", asOf: "2026-09-07T00:00:00Z", axisCompleteness: "complete", confidence: 1 } } };
  const request = { access: input.access, email: "source-correction@example.invalid", dimension: "employees" as const, statement: "현재 상시근로자 수와 공식 자료가 다릅니다.", profile };
  const records = await Promise.all([createSourceCorrection(request, db), createSourceCorrection(request, db)]);
  assert.equal(records[0]!.id, records[1]!.id);
  await assert.rejects(() => createSourceCorrection({ ...request, statement: "다른 설명을 재접수한 것처럼 조용히 버리면 안 됩니다." }, db), { code: "source_correction_exists" });
  assert.equal((await listSourceCorrections(input.access, db)).length, 1);
  assert.equal((await listSourceCorrections({ ...input.access, userId: input.otherId }, db)).length, 0);
  await assert.rejects(() => createSourceCorrection({ ...request, access: { ...input.access, role: "viewer" } }, db), { code: "company_write_forbidden" });
  await assert.rejects(() => updateOwnSourceCorrection({ access: { ...input.access, userId: input.otherId }, id: records[0]!.id, revision: 1, action: "recheck", profile }, db), { code: "company_write_forbidden" });
  const updated = await updateOwnSourceCorrection({ access: input.access, id: records[0]!.id, revision: 1, action: "recheck", profile: { ...profile, employees_count: 8 } }, db);
  assert.equal(updated.observation?.value, 8);
  assert.equal(updated.baseline.value, 20);
  await assert.rejects(() => updateOwnSourceCorrection({ access: input.access, id: updated.id, revision: 1, action: "withdraw", profile }, db), { code: "source_correction_conflict" });
  await assert.rejects(() => input.admin`update profile_source_corrections set baseline='{}' where id=${updated.id}`, /immutable/);
  await assert.rejects(() => input.admin`update profile_source_corrections set events='[]', revision=revision+1 where id=${updated.id}`, /history/);
  const own = await input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${input.access.userId},true)`;
    const visible = await tx`select id from profile_source_corrections`;
    const writes = await tx`update profile_source_corrections set status='resolved' where id=${updated.id} returning id`;
    assert.equal(writes.length, 0);
    return visible;
  });
  assert.equal(own.length, 1);
  await input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${input.otherId},true)`;
    assert.equal((await tx`select id from profile_source_corrections`).length, 0);
  });
  console.log("PASS: correction creation is atomic/idempotent; source/history immutable; stale, foreign and direct user writes blocked");
}

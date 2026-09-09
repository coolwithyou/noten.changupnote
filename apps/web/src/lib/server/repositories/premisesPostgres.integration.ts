import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { CompanyProfile, PremisesProfileValue } from "@cunote/contracts";
import * as schema from "../db/schema";
import { createDrizzleRepositories } from "./drizzle";

const AS_OF = "2026-09-08T15:30:00.000Z";

export async function verifyPremisesPostgres(input: {
  admin: postgres.Sql;
  client: postgres.Sql;
}): Promise<void> {
  const companies = createDrizzleRepositories({
    dialect: "drizzle",
    client: drizzle(input.client, { schema }),
  }).companies;
  const ownerId = crypto.randomUUID();
  const editorId = crypto.randomUUID();
  const companyId = crypto.randomUUID();
  await input.admin`insert into users(id,email) values
    (${ownerId},${`${ownerId}@example.invalid`}),
    (${editorId},${`${editorId}@example.invalid`})`;
  await companies.createCompany({
    userId: ownerId,
    creationId: companyId,
    profile: { name: "premises-v1 PostgreSQL 격리" },
  });
  await input.admin`insert into user_company(user_id,company_id,role)
    values (${editorId},${companyId},'member')`;

  const ownerInitial = (await companies.resolveCompanyProfile({ companyId, userId: ownerId }))!;
  const ownerPremises = premises("11", "headquarters", "10000000-0000-4000-8000-000000000001");
  await companies.saveCompanyProfile({
    companyId,
    userId: ownerId,
    expectedProfile: ownerInitial,
    profile: withPremises({ ...ownerInitial, employees_count: 7 }, ownerPremises),
  });
  const ownerReopened = (await companies.resolveCompanyProfile({ companyId, userId: ownerId }))!;
  assert.deepEqual(ownerReopened.premises, ownerPremises, "owner compound value must reopen exactly");
  assert.equal(ownerReopened.employees_count, 7);

  const editorInitial = (await companies.resolveCompanyProfile({ companyId, userId: editorId }))!;
  assert.equal(editorInitial.premises, undefined, "another user must not read the owner's personal premises");
  const editorPremises = premises("26", "factory", "20000000-0000-4000-8000-000000000002");
  await companies.saveCompanyProfile({
    companyId,
    userId: editorId,
    expectedProfile: editorInitial,
    profile: withPremises(editorInitial, editorPremises),
  });
  assert.deepEqual(
    (await companies.resolveCompanyProfile({ companyId, userId: editorId }))!.premises,
    editorPremises,
    "editor must reopen only their own personal premises",
  );
  assert.deepEqual(
    (await companies.resolveCompanyProfile({ companyId, userId: ownerId }))!.premises,
    ownerPremises,
    "editor save must not replace the owner's answer",
  );

  const beforeUnrelated = (await companies.resolveCompanyProfile({ companyId, userId: ownerId }))!;
  await companies.saveCompanyProfile({
    companyId,
    userId: ownerId,
    expectedProfile: beforeUnrelated,
    profile: { ...beforeUnrelated, revenue_krw: 123_000_000 },
  });
  const afterUnrelated = (await companies.resolveCompanyProfile({ companyId, userId: ownerId }))!;
  assert.deepEqual(afterUnrelated.premises, ownerPremises, "unrelated whole-scope save must preserve premises");
  assert.equal(afterUnrelated.revenue_krw, 123_000_000);

  const systemProfile = await companies.resolveCompanyProfile({ companyId });
  assert.equal(systemProfile?.premises, undefined, "userless system recompute input must not see personal premises");
  const rows = await input.admin`
    select user_id from company_profiles
    where company_id=${companyId} and dimension='premises'
    order by user_id`;
  assert.deepEqual(rows.map((row) => row.user_id), [ownerId, editorId].sort());
  assert.equal(rows.some((row) => row.user_id === null), false, "premises must never persist as a shared row");
  console.log("PASS: premises-v1 PostgreSQL rows preserve exact JSON, unrelated fields and A/B/system isolation");
}

function premises(
  sidoCode: string,
  facilityType: PremisesProfileValue["locations"][number]["facilityType"],
  locationId: string,
): PremisesProfileValue {
  return {
    schemaVersion: "premises-v1",
    locations: [{ locationId, facilityType, sidoCode, validFrom: "2026-01-01", validTo: null }],
    coverage: {
      facilityTypes: [facilityType],
      validFrom: "2026-01-01",
      validTo: "2026-09-09",
      asOf: AS_OF,
      completeness: "complete",
    },
  };
}

function withPremises(profile: CompanyProfile, value: PremisesProfileValue): CompanyProfile {
  return {
    ...profile,
    premises: value,
    confidence: { ...(profile.confidence ?? {}), premises: 0.6 },
    profile_evidence: {
      ...(profile.profile_evidence ?? {}),
      premises: {
        sourceKind: "self_declared",
        provider: "cunote_profile_question",
        asOf: AS_OF,
        axisCompleteness: value.coverage.completeness,
        confidence: 0.6,
        scope: "user",
        persistenceClass: "portable_user_answer",
      },
    },
  };
}

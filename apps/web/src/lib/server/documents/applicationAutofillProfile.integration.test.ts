/**
 * 신청서 등록정보 Postgres/RLS 통합 테스트.
 * 운영 Supabase를 명시적으로 거부하고 일회용 로컬 Postgres에서만 실행한다.
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import { closeCunoteDb } from "../db/client";
import {
  ApplicationAutofillProfileError,
  loadApplicationAutofillProfile,
  saveApplicationAutofillProfile,
} from "./applicationAutofillProfile";

const appUrl = process.env.DATABASE_URL ?? "";
const adminUrl = process.env.PROFILE_AUTOFILL_TEST_ADMIN_DATABASE_URL ?? "";
for (const [name, value] of [["DATABASE_URL", appUrl], ["PROFILE_AUTOFILL_TEST_ADMIN_DATABASE_URL", adminUrl]]) {
  if (!value) throw new Error(`${name}이 필요합니다.`);
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`ABORT: ${name}은 일회용 로컬 Postgres만 허용합니다. host=${host}`);
  }
}

const admin = postgres(adminUrl, { prepare: false, max: 1 });
const app = postgres(appUrl, { prepare: false, max: 2 });
if (new URL(appUrl).username !== "cunote_profile_test_app") {
  throw new Error("DATABASE_URL 사용자는 cunote_profile_test_app이어야 합니다.");
}
const user1 = crypto.randomUUID();
const user2 = crypto.randomUUID();
const company1 = crypto.randomUUID();
const company2 = crypto.randomUUID();

try {
  await admin.unsafe(`DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cunote_profile_test_app') THEN
        CREATE ROLE cunote_profile_test_app LOGIN PASSWORD 'profileapp' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
  $role$`);
  await admin.unsafe("GRANT CONNECT ON DATABASE cunote_profile_test TO cunote_profile_test_app");
  await admin.unsafe("GRANT USAGE ON SCHEMA public, app_private TO cunote_profile_test_app");
  await admin.unsafe("GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO cunote_profile_test_app");
  await admin.unsafe(`GRANT SELECT ON users, companies, user_company,
    user_application_profiles, company_application_profiles TO cunote_profile_test_app`);
  await admin.unsafe(`GRANT INSERT, UPDATE ON user_application_profiles,
    company_application_profiles TO cunote_profile_test_app`);
  await admin.unsafe("GRANT UPDATE (name, biz_no, verified, verified_at, verify_method) ON companies TO cunote_profile_test_app");

  await admin`INSERT INTO users (id, email, name) VALUES
    (${user1}, ${`profile-${user1}@example.com`}, ${"기본 이름 1"}),
    (${user2}, ${`profile-${user2}@example.com`}, ${"기본 이름 2"})`;
  await admin`INSERT INTO companies (id, kind, name, created_by) VALUES
    (${company1}, 'active', ${"기존 회사 1"}, ${user1}),
    (${company2}, 'active', ${"기존 회사 2"}, ${user2})`;
  await admin`INSERT INTO user_company (user_id, company_id, role) VALUES
    (${user1}, ${company1}, 'owner'),
    (${user2}, ${company2}, 'owner')`;

  const access1 = access(user1, company1);
  const access2 = access(user2, company2);
  const saved1 = await saveApplicationAutofillProfile({
    access: access1,
    profile: profileInput({
      name: "테스트 회사 1",
      fullName: "홍 길동",
      businessNumber: "123-45-67891",
    }),
  });
  assert.equal(saved1.personal.fullName, "홍 길동");
  assert.equal(saved1.personal.applicationEmail, "user@example.com");
  assert.equal(saved1.company.name, "테스트 회사 1");
  assert.equal(saved1.company.businessNumber, "1234567891");
  assert.equal(saved1.company.businessNumberVerified, false);

  await saveApplicationAutofillProfile({
    access: access2,
    profile: profileInput({
      name: "테스트 회사 2",
      fullName: "김 사용자",
      businessNumber: "746-54-00870",
    }),
  });

  const loaded1 = await loadApplicationAutofillProfile(access1);
  assert.equal(loaded1.personal.phone, "010-1234-5678");
  assert.equal(loaded1.company.addressLine1, "서울 강남구 테헤란로 1");

  const visible = await app.begin(async (tx) => {
    await tx`SELECT set_config('app.current_user_id', ${user1}, true)`;
    const personal = await tx<{ user_id: string }[]>`SELECT user_id FROM user_application_profiles ORDER BY user_id`;
    const companies = await tx<{ company_id: string }[]>`SELECT company_id FROM company_application_profiles ORDER BY company_id`;
    return { personal, companies };
  });
  assert.deepEqual(visible.personal.map((row) => row.user_id), [user1]);
  assert.deepEqual(visible.companies.map((row) => row.company_id), [company1]);

  await assert.rejects(
    () => loadApplicationAutofillProfile({ ...access2, companyId: company1 }),
    (error) => error instanceof ApplicationAutofillProfileError
      && error.code === "profile_scope_not_found"
      && error.status === 404,
  );

  await admin`UPDATE companies SET verified = true, verified_at = now(), verify_method = 'integration-test'
    WHERE id = ${company1}`;
  await assert.rejects(
    () => saveApplicationAutofillProfile({
      access: access1,
      profile: profileInput({
        name: "테스트 회사 1",
        fullName: "홍 길동",
        businessNumber: "746-54-00870",
      }),
    }),
    (error) => error instanceof ApplicationAutofillProfileError
      && error.code === "verified_business_number_conflict"
      && error.status === 409,
  );

  console.log("application autofill profile Postgres/RLS integration tests passed");
} finally {
  await closeCunoteDb();
  await app.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
}

function access(userId: string, companyId: string): CompanyAccess {
  return { userId, companyId, role: "owner", mode: "session" };
}

function profileInput(input: { name: string; fullName: string; businessNumber: string }) {
  return {
    personal: {
      fullName: input.fullName,
      applicationEmail: "USER@EXAMPLE.COM",
      phone: "010-1234-5678",
      postalCode: "06236",
      addressLine1: "서울 강남구 테헤란로 1",
      addressLine2: "101호",
    },
    company: {
      name: input.name,
      representativeName: input.fullName,
      businessNumber: input.businessNumber,
      applicationEmail: "company@example.com",
      phone: "02-1234-5678",
      postalCode: "06236",
      addressLine1: "서울 강남구 테헤란로 1",
      addressLine2: "2층",
    },
  };
}

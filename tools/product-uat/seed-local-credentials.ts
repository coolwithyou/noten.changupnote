import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const socket = requiredEnv("PGHOST");
assert.match(realpathSync(socket), /^\/private\/var\/folders\/.+\/cunote-product-uat-pg-[a-zA-Z0-9]+$/);
assert.equal(process.env.DATABASE_URL, "postgres:///postgres");
assert.equal(process.env.PGUSER, "postgres");

const requireFromWeb = createRequire(pathToFileURL(`${process.cwd()}/apps/web/package.json`));
const bcrypt = requireFromWeb("bcryptjs") as {
  hash(value: string, rounds: number): Promise<string>;
};
const sql = postgres(requiredEnv("DATABASE_URL"), {
  max: 1,
  prepare: false,
  connection: { statement_timeout: 20_000 },
  onnotice: () => {},
});

export const LOCAL_UAT_IDS = {
  owner: "10000000-0000-4000-8000-000000000001",
  editor: "10000000-0000-4000-8000-000000000002",
  viewer: "10000000-0000-4000-8000-000000000003",
  companyA: "20000000-0000-4000-8000-000000000001",
  companyB: "20000000-0000-4000-8000-000000000002",
  admin: "30000000-0000-4000-8000-000000000001",
} as const;

try {
  const [before] = await sql<{ count: number }[]>`
    select count(*)::int as count from pg_tables where schemaname = 'public'
  `;
  assert.equal(before?.count, 0, "비어 있는 전용 UAT cluster에만 migration을 적용한다");

  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  assert.equal(journal.entries.length, 83, "UAT fixture가 기대하는 migration 수가 바뀌면 다시 검토한다");
  for (const entry of journal.entries) {
    const statements = readFileSync(`db/migrations/${entry.tag}.sql`, "utf8")
      .split("--> statement-breakpoint");
    for (const statement of statements) {
      if (statement.trim()) await sql.unsafe(statement);
    }
  }

  const userPasswordHash = await bcrypt.hash(requiredEnv("CUNOTE_LOCAL_UAT_USER_PASSWORD"), 12);
  const adminPasswordHash = await bcrypt.hash(requiredEnv("CUNOTE_LOCAL_UAT_ADMIN_PASSWORD"), 12);
  const acceptedAt = new Date("2026-09-08T00:00:00.000Z");
  const profileObservedAt = new Date("2026-09-07T00:00:00.000Z");

  await sql`
    insert into users
      (id, email, name, password_hash, terms_accepted_at, privacy_accepted_at, terms_version, privacy_version)
    values
      (${LOCAL_UAT_IDS.owner}, 'sw@noten.im', '격리 소유자', ${userPasswordHash}, ${acceptedAt}, ${acceptedAt}, 'uat-v1', 'uat-v1'),
      (${LOCAL_UAT_IDS.editor}, 'dev@noten.im', '격리 편집자', ${userPasswordHash}, ${acceptedAt}, ${acceptedAt}, 'uat-v1', 'uat-v1'),
      (${LOCAL_UAT_IDS.viewer}, 'guest@noten.im', '격리 조회 전용', ${userPasswordHash}, ${acceptedAt}, ${acceptedAt}, 'uat-v1', 'uat-v1')
  `;
  await sql`
    insert into companies (id, kind, name, created_by)
    values
      (${LOCAL_UAT_IDS.companyA}, 'active', '격리 합성 회사 A', ${LOCAL_UAT_IDS.owner}),
      (${LOCAL_UAT_IDS.companyB}, 'active', '격리 합성 회사 B', ${LOCAL_UAT_IDS.owner})
  `;
  await sql`
    insert into company_profiles (company_id, user_id, dimension, value, source, confidence, as_of)
    values
      (${LOCAL_UAT_IDS.companyA}, ${LOCAL_UAT_IDS.owner}, 'region', ${sql.json({ code: "11", label: "서울" })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyA}, ${LOCAL_UAT_IDS.owner}, 'biz_age', ${sql.json({ biz_age_months: 24, months: 24 })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyA}, ${LOCAL_UAT_IDS.owner}, 'industry', ${sql.json({ industries: ["소프트웨어 개발업"], tags: ["소프트웨어 개발업"], industry_codes: ["J"], codes: ["J"], list_completeness: "complete" })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyA}, ${LOCAL_UAT_IDS.owner}, 'target_type', ${sql.json({ target_types: ["existing_business"], targets: ["existing_business"], list_completeness: "complete" })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyB}, ${LOCAL_UAT_IDS.owner}, 'region', ${sql.json({ code: "26", label: "부산" })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyB}, ${LOCAL_UAT_IDS.owner}, 'biz_age', ${sql.json({ biz_age_months: 60, months: 60 })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyB}, ${LOCAL_UAT_IDS.owner}, 'industry', ${sql.json({ industries: ["소프트웨어 개발업"], tags: ["소프트웨어 개발업"], industry_codes: ["J"], codes: ["J"], list_completeness: "complete" })}, 'self_declared', 1, ${profileObservedAt}),
      (${LOCAL_UAT_IDS.companyB}, ${LOCAL_UAT_IDS.owner}, 'target_type', ${sql.json({ target_types: ["existing_business"], targets: ["existing_business"], list_completeness: "complete" })}, 'self_declared', 1, ${profileObservedAt})
  `;
  await sql`
    insert into user_company (user_id, company_id, role)
    values
      (${LOCAL_UAT_IDS.owner}, ${LOCAL_UAT_IDS.companyA}, 'owner'),
      (${LOCAL_UAT_IDS.owner}, ${LOCAL_UAT_IDS.companyB}, 'owner'),
      (${LOCAL_UAT_IDS.editor}, ${LOCAL_UAT_IDS.companyA}, 'member'),
      (${LOCAL_UAT_IDS.viewer}, ${LOCAL_UAT_IDS.companyA}, 'viewer')
  `;
  await sql`
    insert into admin_users (id, email, name, password_hash, role, status)
    values (${LOCAL_UAT_IDS.admin}, 'manager@noten.im', '격리 운영 관리자', ${adminPasswordHash}, 'admin', 'active')
  `;

  const [counts] = await sql<{ users: number; companies: number; profiles: number; memberships: number; admins: number }[]>`
    select
      (select count(*)::int from users) as users,
      (select count(*)::int from companies) as companies,
      (select count(*)::int from company_profiles) as profiles,
      (select count(*)::int from user_company) as memberships,
      (select count(*)::int from admin_users) as admins
  `;
  assert.deepEqual(counts, { users: 3, companies: 2, profiles: 8, memberships: 4, admins: 1 });
  console.log(JSON.stringify({
    ok: true,
    suite: "local-product-uat-seed",
    migrations: journal.entries.length,
    counts,
    credentialMode: "bcrypt-password",
  }));
} finally {
  await sql.end({ timeout: 5 });
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key}가 필요합니다.`);
  return value;
}

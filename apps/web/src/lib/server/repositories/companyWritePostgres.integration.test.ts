import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { createDrizzleRepositories } from "./drizzle";
import { companyCreationIdentity } from "../productProfile/companyCreationIdentity";
import { verifyDocumentJourneyPostgres } from "../documents/documentJourneyPostgres.integration";
import { loadProductExposureSummary, recordProductExposure, signExposureBinding } from "../productReadiness/exposure";
import { verifySourceCorrectionsPostgres } from "../productProfile/sourceCorrectionsPostgres.integration";
import { verifyConfirmationEvaluationsPostgres } from "../matches/confirmationEvaluationsPostgres.integration";
import { verifyMatchStateInputRevisionPostgres } from "../matches/matchStateInputRevisionPostgres.integration";
import { verifyPromotionServingSnapshotPostgres } from "./promotionServingSnapshotPostgres.integration";
import { verifyPremisesPostgres } from "./premisesPostgres.integration";

const socket = process.env.CUNOTE_PRODUCT_TEST_SOCKET ?? "";
assert.match(socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);
assert.match(realpathSync(socket), /^\/(?:private\/)?tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);
const admin = postgres({ host: socket, database: "postgres", username: "postgres", prepare: false, max: 1, onnotice: () => {} });
let client: postgres.Sql | undefined;
try {
  const [empty] = await admin`select count(*)::int as count from pg_tables where schemaname='public'`;
  assert.equal(empty!.count, 0, "비어 있는 전용 cluster에만 migration을 적용한다");
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    for (const statement of readFileSync(`db/migrations/${entry.tag}.sql`, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await admin.unsafe(statement);
    }
  }
  await admin`create role product_test login nosuperuser nobypassrls`;
  await admin`grant usage on schema public, app_private to product_test`;
  await admin`grant select, insert, update, delete on all tables in schema public to product_test`;
  await admin`grant usage on all sequences in schema public to product_test`;
  client = postgres({ host: socket, database: "postgres", username: "product_test", prepare: false, max: 8, connection: { statement_timeout: 10_000 } });
  const repo = createDrizzleRepositories({ dialect: "drizzle", client: drizzle(client, { schema }) }).companies;
  const userId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  await admin`insert into users(id,email) values (${userId},${`${userId}@example.invalid`}),(${otherId},${`${otherId}@example.invalid`})`;
  const profile = { name: "격리 검증 회사", employees_count: 0 };
  const creationId = companyCreationIdentity(userId, crypto.randomUUID(), profile)!;
  const created = await Promise.all(Array.from({ length: 6 }, () => repo.createCompany({ userId, creationId, profile })));
  assert.ok(created.every((record) => record.id === creationId));
  const [count] = await admin`select (select count(*)::int from companies) as companies, (select count(*)::int from user_company) as memberships`;
  assert.deepEqual({ companies: count!.companies, memberships: count!.memberships }, { companies: 1, memberships: 1 });
  console.log("PASS: concurrent identical create requests produce one company and owner membership");

  const expected = (await repo.resolveCompanyProfile({ companyId: creationId, userId }))!;
  const writes = await Promise.allSettled([11, 22].map((employees_count) => repo.saveCompanyProfile({
    companyId: creationId, userId, expectedProfile: expected, profile: { ...expected, employees_count },
  })));
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = writes.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.code, "company_profile_conflict");
  const reopened = (await repo.resolveCompanyProfile({ companyId: creationId, userId }))!;
  assert.ok([11, 22].includes(reopened.employees_count!));
  const replay = await repo.createCompany({ userId, creationId, profile });
  assert.equal(replay.profile.employees_count, reopened.employees_count);
  console.log("PASS: actual row lock yields one save and one conflict; retry preserves latest saved answers");

  assert.equal(await repo.resolveCompanyProfile({ companyId: creationId, userId: otherId }), null);
  await assert.rejects(() => repo.createCompany({ userId: otherId, creationId, profile }));
  await admin`insert into user_company(user_id,company_id,role) values (${otherId},${creationId},'viewer')`;
  assert.ok(await repo.resolveCompanyProfile({ companyId: creationId, userId: otherId }));
  const escalated = await client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${otherId},true)`;
    return tx`update user_company set role='owner' where user_id=${otherId} and company_id=${creationId} returning role`;
  });
  assert.equal(escalated.length, 0, "viewer가 자신의 role을 owner로 승격할 수 없다");
  await assert.rejects(() => repo.saveCompanyProfile({ companyId: creationId, userId: otherId, profile: { employees_count: 999 } }));
  assert.equal((await repo.resolveCompanyProfile({ companyId: creationId, userId }))!.employees_count, reopened.employees_count);
  await verifyDocumentJourneyPostgres({ admin, socket, access: { companyId: creationId, userId, role: "owner", mode: "session" } });
  const [grant] = await admin`select id from grants limit 1`;
  const releaseDbId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  await admin`insert into analysis_lab_promotion_releases
    (id,release_id,manifest_sha256,release_plan_sha256,manifest,git_commit,build_digest,status,created_by)
    values (${releaseDbId},${releaseDbId},${"a".repeat(64)},${"b".repeat(64)},'{}','fixture','fixture','active','fixture')`;
  await admin`insert into analysis_lab_promotion_items
    (id,release_db_id,grant_id,run_id,plan_sha256,before_snapshot,before_sha256,status,applied_at)
    values (${itemId},${releaseDbId},${grant!.id},'fixture',${"c".repeat(64)},'{}',${"d".repeat(64)},'applied','2026-09-06T00:00:00Z')`;
  const secret = "isolated-exposure-fixture-signing-secret";
  const now = new Date("2026-09-06T00:01:00Z");
  const token = signExposureBinding({ version: 1, itemId, grantId: String(grant!.id), userId, companyId: creationId, issuedAt: now.getTime() }, secret);
  const exposureDb = drizzle(admin, { schema });
  await Promise.all(Array.from({ length: 4 }, () => recordProductExposure({ token, companyId: creationId, userId }, { db: exposureDb, secret, now, enabled: true })));
  await recordProductExposure({ token, companyId: creationId, userId }, { db: exposureDb, secret, now: new Date(now.getTime() + 30_000), enabled: true });
  const exposure = await loadProductExposureSummary(exposureDb);
  assert.equal(exposure.observedRevisions, 1);
  assert.equal(exposure.minimumSeconds, 60);
  assert.equal(exposure.maximumSeconds, 60);
  await assert.rejects(() => admin`update product_promotion_exposures set first_received_at=now() where promotion_item_id=${itemId}`, /append-only/);
  await admin`update analysis_lab_promotion_items set status='rolled_back' where id=${itemId}`;
  await recordProductExposure({ token, companyId: creationId, userId }, { db: exposureDb, secret, now, enabled: true });
  assert.equal((await loadProductExposureSummary(exposureDb)).observedRevisions, 1);
  console.log("PASS: signed exposure SQL deduplicates concurrent requests and protects original receive time");
  await verifySourceCorrectionsPostgres({ admin, client, access: { companyId: creationId, userId, role: "owner", mode: "session" }, otherId });
  await verifyConfirmationEvaluationsPostgres({
    admin,
    client,
    socket,
    companyId: creationId,
    userId,
    viewerId: otherId,
  });
  await verifyMatchStateInputRevisionPostgres({
    admin,
    client,
    companyId: creationId,
    userId,
  });
  await verifyPromotionServingSnapshotPostgres({ admin, socket });
  await verifyPremisesPostgres({ admin, client });
  await admin`delete from user_company where user_id=${userId} and company_id=${creationId}`;
  await assert.rejects(() => repo.createCompany({ userId, creationId, profile }));
  console.log("PASS: non-superuser RLS blocks foreign access, viewer writes and replay after membership removal");
  console.log(JSON.stringify({ ok: true, suite: "product-postgres", migrations: journal.entries.length, rls: true, network: "private_unix_socket_only" }));
} finally {
  if (client) await client.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
}

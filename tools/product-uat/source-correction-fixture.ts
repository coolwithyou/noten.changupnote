import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { sourceSnapshotIdentity, type SourceCorrectionSnapshot } from "../../packages/contracts/src/source-correction";
import {
  buildRegistryEmployeesRow,
  SOURCE_CORRECTION_UAT,
  type SourceCorrectionObservationPhase,
} from "./source-correction-observation";

type Action = "seed" | "advance" | "inspect";

export function parseSourceCorrectionFixtureArgs(args: string[]): { action: Action } {
  assert.equal(args.length, 1, "--action=<seed|advance|inspect> 하나가 필요합니다");
  const action = args[0]?.match(/^--action=(seed|advance|inspect)$/)?.[1];
  assert.ok(action);
  return { action: action as Action };
}

type SourceCorrectionFixtureRuntimeFs = {
  lstatSyncImpl?: (path: string) => {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    uid: number;
  };
  readFileSyncImpl?: (path: string) => string;
  realpathSyncImpl?: (path: string) => string;
  getuidImpl?: (() => number) | null;
};

export function validateSourceCorrectionFixtureRuntime(
  env: Readonly<Record<string, string | undefined>>,
  fs: SourceCorrectionFixtureRuntimeFs = {},
) {
  const lstat = fs.lstatSyncImpl ?? ((path: string) => lstatSync(path));
  const readFile = fs.readFileSyncImpl ?? ((path: string) => readFileSync(path, "utf8"));
  const realpath = fs.realpathSyncImpl ?? ((path: string) => realpathSync(path));
  const getuid = fs.getuidImpl === undefined
    ? (typeof process.getuid === "function" ? () => process.getuid() : null)
    : fs.getuidImpl;
  const socket = requiredEnv(env, "PGHOST");
  const socketStat = lstat(socket);
  assert.ok(socketStat.isDirectory() && !socketStat.isSymbolicLink(), "PGHOST는 실제 격리 runtime 디렉터리여야 합니다");
  assert.equal(socketStat.mode & 0o777, 0o700);
  if (getuid !== null) assert.equal(socketStat.uid, getuid());
  const socketRoot = realpath(socket);
  assert.match(socketRoot, /^\/private\/var\/folders\/.+\/cunote-product-uat-pg-[a-zA-Z0-9]+$/);
  assert.equal(env.DATABASE_URL, "postgres:///postgres");
  assert.equal(env.PGUSER, "postgres");
  const runtimeRoot = realpath(requiredEnv(env, "CUNOTE_PRODUCT_UAT_RUNTIME_ROOT"));
  assert.equal(socketRoot, runtimeRoot);
  const markerPath = join(runtimeRoot, ".cunote-product-uat-owner.json");
  const markerStat = lstat(markerPath);
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink(), "owner marker는 실제 일반 파일이어야 합니다");
  assert.equal(markerStat.mode & 0o777, 0o600);
  if (getuid !== null) assert.equal(markerStat.uid, getuid());
  const ownerMarker = JSON.parse(readFile(markerPath));
  assert.equal(ownerMarker?.schema, "cunote-product-uat-runtime-owner-v1");
  assert.match(ownerMarker?.id ?? "", /^[0-9a-f-]{36}$/i);
  return { socket: socketRoot, runtimeRoot };
}

async function runFixture(action: Action, env: Readonly<Record<string, string | undefined>>) {
  const runtime = validateSourceCorrectionFixtureRuntime(env);
  const sql = postgres(requiredEnv(env, "DATABASE_URL"), {
    max: 1,
    prepare: false,
    connection: { statement_timeout: 20_000 },
    onnotice: () => {},
  });
  return completeFixtureActionBeforeClose(
    async () => {
      if (action === "seed") return await seedObservation(sql, runtime.runtimeRoot);
      if (action === "advance") return await advanceObservation(sql, runtime.runtimeRoot);
      return await inspectFixture(sql);
    },
    () => sql.end({ timeout: 5 }),
  );
}

export async function completeFixtureActionBeforeClose<T>(
  action: () => Promise<T>,
  close: () => Promise<unknown>,
) {
  try {
    return await action();
  } finally {
    await close();
  }
}

async function seedObservation(sql: postgres.Sql, runtimeRoot: string) {
  const existing = await sql`select id from company_profiles where id=${SOURCE_CORRECTION_UAT.profileRowId}`;
  assert.equal(existing.length, 0, "공식 관측 fixture row는 새 격리 DB에 한 번만 생성합니다");
  const companyRows = await sql`select id from companies where id=${SOURCE_CORRECTION_UAT.companyId}`;
  assert.equal(companyRows.length, 1, "격리 회사 A가 필요합니다");
  const binding = await readServingBinding(sql);
  const row = buildRegistryEmployeesRow("before");
  await sql`insert into company_profiles(id,company_id,user_id,dimension,value,source,confidence,as_of,updated_at)
    values (${SOURCE_CORRECTION_UAT.profileRowId},${SOURCE_CORRECTION_UAT.companyId},null,
      ${row.dimension},${sql.json(row.value)},${row.source},${row.confidence},${row.asOf},${row.updatedAt})`;
  const state = await inspectFixture(sql);
  assertObservationState(state.profileRow, "before");
  const receipt = {
    schema: "cunote-local-product-uat-source-correction-fixture-receipt-v1",
    authority: SOURCE_CORRECTION_UAT.authority,
    companyId: SOURCE_CORRECTION_UAT.companyId,
    ownerUserId: SOURCE_CORRECTION_UAT.ownerUserId,
    profileRowId: SOURCE_CORRECTION_UAT.profileRowId,
    correctionGrantId: SOURCE_CORRECTION_UAT.grantId,
    provider: SOURCE_CORRECTION_UAT.provider,
    sourceKind: SOURCE_CORRECTION_UAT.sourceKind,
    dimension: SOURCE_CORRECTION_UAT.dimension,
    before: SOURCE_CORRECTION_UAT.before,
    after: SOURCE_CORRECTION_UAT.after,
    sameRowUpdateRequired: true,
    servingBinding: binding,
    initialRowSha256: sha256Canonical(state.profileRow),
  };
  const receiptPath = join(runtimeRoot, SOURCE_CORRECTION_UAT.fixtureReceipt);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { fixture: SOURCE_CORRECTION_UAT, receiptPath, receipt, state };
}

async function advanceObservation(sql: postgres.Sql, runtimeRoot: string) {
  const before = await inspectFixture(sql);
  assertObservationState(before.profileRow, "before");
  assert.equal(before.corrections.length, 1, "owner의 정정 요청 하나가 필요합니다");
  const correction = before.corrections[0]!;
  assert.equal(correction.companyId, SOURCE_CORRECTION_UAT.companyId);
  assert.equal(correction.userId, SOURCE_CORRECTION_UAT.ownerUserId);
  assert.equal(correction.dimension, SOURCE_CORRECTION_UAT.dimension);
  assert.equal(correction.status, "reviewing", "관리자 검토 시작 뒤에만 공식 관측을 모사 갱신합니다");
  assert.deepEqual(
    correction.events.map((event: { action?: string }) => event.action),
    ["submitted", "review", "recheck"],
    "접수→검토→동일 관측 재확인 뒤에만 fixture를 전진합니다",
  );
  assertSameObservation(correction.baseline, correction.observation);

  const row = buildRegistryEmployeesRow("after");
  const updated = await sql`update company_profiles set
      value=${sql.json(row.value)}, source=${row.source}, confidence=${row.confidence},
      as_of=${row.asOf}, updated_at=${row.updatedAt}
    where id=${SOURCE_CORRECTION_UAT.profileRowId}
      and company_id=${SOURCE_CORRECTION_UAT.companyId}
      and user_id is null
      and dimension=${SOURCE_CORRECTION_UAT.dimension}
    returning id`;
  assert.equal(updated.length, 1, "동일 공식 관측 row 하나만 갱신해야 합니다");
  const after = await inspectFixture(sql);
  assertObservationState(after.profileRow, "after");
  assert.equal(after.profileRow.id, before.profileRow.id);
  assert.equal(after.corrections[0]?.revision, correction.revision, "원천 관측 갱신 자체는 정정 ticket을 바꾸지 않습니다");

  const receipt = {
    schema: "cunote-local-product-uat-source-correction-observation-update-receipt-v1",
    authority: SOURCE_CORRECTION_UAT.authority,
    simulatedAt: new Date().toISOString(),
    profileRowId: SOURCE_CORRECTION_UAT.profileRowId,
    correctionId: correction.id,
    sameRowUpdated: true,
    externalInstitutionContacted: false,
    beforeRowSha256: sha256Canonical(before.profileRow),
    afterRowSha256: sha256Canonical(after.profileRow),
    before: SOURCE_CORRECTION_UAT.before,
    after: SOURCE_CORRECTION_UAT.after,
  };
  const receiptPath = join(runtimeRoot, SOURCE_CORRECTION_UAT.updateReceipt);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { fixture: SOURCE_CORRECTION_UAT, receiptPath, receipt, state: after };
}

async function inspectFixture(sql: postgres.Sql) {
  const profileRows = await sql<Array<{
    id: string;
    companyId: string;
    userId: string | null;
    dimension: string;
    value: Record<string, unknown>;
    source: string;
    confidence: number;
    asOf: Date;
    updatedAt: Date;
  }>>`select id,company_id as "companyId",user_id as "userId",dimension,value,source,confidence,
      as_of as "asOf",updated_at as "updatedAt"
    from company_profiles where id=${SOURCE_CORRECTION_UAT.profileRowId}`;
  assert.equal(profileRows.length, 1, "공식 관측 fixture row 하나가 필요합니다");
  const corrections = await sql<Array<{
    id: string;
    ticketId: string;
    companyId: string;
    userId: string;
    dimension: string;
    status: string;
    baseline: SourceCorrectionSnapshot;
    observation: SourceCorrectionSnapshot | null;
    statement: string;
    events: Array<{ at: string; actor: string; action: string; note: string }>;
    revision: number;
  }>>`select id,ticket_id as "ticketId",company_id as "companyId",user_id as "userId",dimension,status,
      baseline,observation,statement,events,revision
    from profile_source_corrections
    where company_id=${SOURCE_CORRECTION_UAT.companyId} and dimension=${SOURCE_CORRECTION_UAT.dimension}
    order by created_at`;
  const ticketIds = corrections.map((record) => record.ticketId);
  const tickets = ticketIds.length === 0 ? [] : await sql<Array<{ id: string; status: string }>>`
    select id,status from support_tickets where id in ${sql(ticketIds)} order by id`;
  const messages = ticketIds.length === 0 ? [] : await sql<Array<{
    ticketId: string;
    authorType: string;
    authorEmail: string | null;
    body: string;
    visibility: string;
  }>>`select ticket_id as "ticketId",author_type as "authorType",author_email as "authorEmail",body,visibility
    from support_ticket_messages where ticket_id in ${sql(ticketIds)} order by created_at,id`;
  return {
    profileRow: serializeProfileRow(profileRows[0]!),
    corrections,
    tickets,
    messages,
    servingBinding: await readServingBinding(sql),
  };
}

async function readServingBinding(sql: postgres.Sql) {
  const rows = await sql<Array<{
    releaseId: string;
    manifestSha256: string;
    planSha256: string;
    afterSha256: string;
    promotionPlan: {
      grantId: string;
      criteria: Array<{ dimension: string; kind: string; operator: string; value: unknown }>;
      questions: unknown[];
    };
  }>>`select release.release_id as "releaseId",release.manifest_sha256 as "manifestSha256",
      item.plan_sha256 as "planSha256",item.after_sha256 as "afterSha256",
      (select plan_entry->'promotionPlan'
        from jsonb_array_elements(release.manifest->'plans') as plans(plan_entry)
        where plan_entry->>'grantId'=${SOURCE_CORRECTION_UAT.grantId}) as "promotionPlan"
    from analysis_lab_promotion_items item
    join analysis_lab_promotion_releases release on release.id=item.release_db_id
    where item.grant_id=${SOURCE_CORRECTION_UAT.grantId} and item.status='applied' and release.status='active'`;
  assert.equal(rows.length, 1, "정정 공고는 active serving registry의 exact applied item이어야 합니다");
  const row = rows[0]!;
  assert.equal(row.promotionPlan?.grantId, SOURCE_CORRECTION_UAT.grantId);
  assert.deepEqual(row.promotionPlan.criteria.map((criterion) => ({
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
  })), [{ dimension: "employees", kind: "required", operator: "lte", value: { max: 10 } }]);
  assert.deepEqual(row.promotionPlan.questions, []);
  return {
    releaseId: row.releaseId,
    manifestSha256: row.manifestSha256,
    planSha256: row.planSha256,
    afterSha256: row.afterSha256,
    criterion: row.promotionPlan.criteria[0],
  };
}

function assertObservationState(row: ReturnType<typeof serializeProfileRow>, phase: SourceCorrectionObservationPhase) {
  const expected = SOURCE_CORRECTION_UAT[phase];
  assert.equal(row.id, SOURCE_CORRECTION_UAT.profileRowId);
  assert.equal(row.companyId, SOURCE_CORRECTION_UAT.companyId);
  assert.equal(row.userId, null);
  assert.equal(row.dimension, SOURCE_CORRECTION_UAT.dimension);
  assert.equal(row.value.employees_count, expected.employeesCount);
  assert.equal(row.value.count, expected.employeesCount);
  assert.equal(row.source, "self_declared", "legacy transport enum과 embedded registry provenance를 구분합니다");
  assert.equal(row.evidence.sourceKind, SOURCE_CORRECTION_UAT.sourceKind);
  assert.equal(row.evidence.provider, SOURCE_CORRECTION_UAT.provider);
  assert.equal(row.evidence.scope, "shared");
  assert.equal(row.evidence.asOf, expected.asOf);
  assert.equal(row.evidence.observationVersion, expected.observationVersion);
  assert.equal(row.evidence.canonicalValue, String(expected.employeesCount));
}

function assertSameObservation(baseline: SourceCorrectionSnapshot, observation: SourceCorrectionSnapshot | null) {
  assert.ok(observation, "동일 원천 재확인 observation이 필요합니다");
  assert.equal(sourceSnapshotIdentity(baseline), sourceSnapshotIdentity(observation));
  assert.equal(observation.value, SOURCE_CORRECTION_UAT.before.employeesCount);
}

function serializeProfileRow(row: {
  id: string;
  companyId: string;
  userId: string | null;
  dimension: string;
  value: Record<string, unknown>;
  source: string;
  confidence: number;
  asOf: Date;
  updatedAt: Date;
}) {
  const evidence = row.value._cunote_profile_evidence as Record<string, unknown> | undefined;
  assert.ok(evidence);
  return {
    ...row,
    asOf: row.asOf.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    evidence,
  };
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key}가 필요합니다`);
  return value;
}

async function main() {
  const { action } = parseSourceCorrectionFixtureArgs(process.argv.slice(2));
  const result = await runFixture(action, process.env);
  console.log(JSON.stringify({ ok: true, action, ...result }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();

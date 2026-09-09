import assert from "node:assert/strict";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { loadActiveServingMonitorInventory } from "./servingMonitorInventory";
import { createDrizzleRepositories, withPromotionServingReadSnapshot } from "../repositories/drizzle";
import type { CunoteDb } from "../db/client";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import { prepareDeepAnalysisInput } from "./prepareInput";
import { verifyActiveServingTarget } from "./verify-serving-cli";
import { loadPromotionGrantSnapshot, promotionGrantSnapshotStateSha256 } from "../analysis-lab/promotion-snapshot";
import {
  createPromotionReleaseManifest,
  planSha256,
  validatePromotionReleaseManifest,
  sha256Canonical,
} from "../analysis-lab/promotion-release";

/** 실제 서비스 DB에 연결하지 않는 전용 product-postgres fixture. */
async function seedMonitorFixtures(input: { admin: postgres.Sql; socket: string }) {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);
  const [templateRow] = await input.admin<{ manifest: unknown }[]>`
    select manifest from analysis_lab_promotion_releases
    where created_by = 'isolated-postgres' and status = 'active'
    limit 1
  `;
  assert.ok(templateRow, "앞선 snapshot integration의 verified local fixture가 필요합니다");
  const template = validatePromotionReleaseManifest(templateRow.manifest);
  const asOf = new Date("2026-09-09T00:10:00.000Z");

  async function add(inputRow: {
    label: string;
    grantId?: string;
    releaseStatus?: "active" | "canary_passed" | "approved" | "rolled_back";
    itemStatus?: "applied" | "prepared";
    status?: "open" | "closed";
    hidden?: boolean;
    expired?: boolean;
    production?: boolean;
    appliedAt?: string | null;
  }) {
    const grantId = inputRow.grantId ?? crypto.randomUUID();
    if (!inputRow.grantId) {
      await input.admin`
        insert into grants (id, source, source_id, title, status, overall_confidence,
          serving_state, apply_end)
        values (${grantId}, 'bizinfo', ${grantId}, ${`격리 monitor ${inputRow.label}`},
          ${inputRow.status ?? "open"}, 1, ${inputRow.hidden ? "suppressed" : "visible"},
          ${inputRow.expired ? "2026-09-08T00:00:00Z" : "2026-09-30T00:00:00Z"})
      `;
    }
    const releaseDbId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const runId = `run-2026-09-09T000000.000Z-${crypto.randomUUID().slice(0, 8)}`;
    const plan = { ...structuredClone(template.plans[0]!.promotionPlan), grantId, runId };
    plan.conversion = { ...plan.conversion, grantId, runId };
    const planItem = {
      ...structuredClone(template.plans[0]!),
      grantId,
      promotionPlan: plan,
      planSha256: planSha256(plan),
    };
    const artifact = {
      ...structuredClone(template.sourceArtifacts[0]!), grantId, runId,
      sourceRevisionSha256: "c".repeat(64),
    };
    const manifest = createPromotionReleaseManifest({
      releaseId: `monitor-postgres-${releaseDbId}`,
      revision: 1,
      createdAt: "2026-09-09T00:00:00.000Z",
      gitCommit: template.gitCommit,
      buildDigest: template.buildDigest,
      cohortLabel: "isolated-monitor-postgres",
      canaryGrantIds: [grantId],
      sourceArtifacts: [artifact],
      plans: [planItem],
    });
    let deepAnalysisRunId: string | null = null;
    if (inputRow.production) {
      const jobId = crypto.randomUUID();
      deepAnalysisRunId = crypto.randomUUID();
      await input.admin`
        insert into grant_deep_analysis_jobs
          (id, grant_id, source_revision_sha256, model_policy_version, status)
        values (${jobId}, ${grantId}, ${"c".repeat(64)}, 'isolated-monitor', 'succeeded')
      `;
      await input.admin`
        insert into grant_deep_analysis_runs
          (id, run_id, job_id, grant_id, source_revision_sha256, attachment_manifest_sha256,
           input_sha256, input_artifact_key, model, prompt_version, model_policy_version,
           status, input_chars, completed_at)
        values (${deepAnalysisRunId}, ${runId}, ${jobId}, ${grantId}, ${"c".repeat(64)},
          ${"d".repeat(64)}, ${"e".repeat(64)}, 'isolated/no-object', 'isolated-no-model',
          'isolated-prompt', 'isolated-monitor', 'passed', 0, '2026-09-09T00:00:00Z')
      `;
    }
    await input.admin`
      insert into analysis_lab_promotion_releases
        (id, release_id, manifest_sha256, release_plan_sha256, manifest,
         git_commit, build_digest, status, created_by)
      values (${releaseDbId}, ${manifest.releaseId}, ${manifest.manifestSha256},
        ${manifest.releasePlanSha256}, ${JSON.stringify(manifest)}::jsonb,
        ${manifest.gitCommit}, ${manifest.buildDigest}, ${inputRow.releaseStatus ?? "active"},
        'isolated-monitor-postgres')
    `;
    const appliedAt = inputRow.appliedAt === undefined
      ? "2026-09-09T00:02:00Z" : inputRow.appliedAt;
    await input.admin`
      insert into analysis_lab_promotion_items
        (id, release_db_id, grant_id, run_id, deep_analysis_run_id, plan_sha256,
         before_snapshot, before_sha256, after_sha256, status, applied_at)
      values (${itemId}, ${releaseDbId}, ${grantId}, ${runId}, ${deepAnalysisRunId},
        ${planItem.planSha256}, '{}'::jsonb, ${"a".repeat(64)}, ${"b".repeat(64)},
        ${inputRow.itemStatus ?? "applied"}, ${appliedAt})
    `;
    return { grantId, releaseDbId, itemId, runId, deepAnalysisRunId };
  }

  const local = await add({ label: "local" });
  const canary = await add({ label: "canary", releaseStatus: "canary_passed" });
  const production = await add({ label: "production", production: true });
  const hidden = await add({ label: "hidden", hidden: true });
  const closed = await add({ label: "closed", status: "closed" });
  const expired = await add({ label: "expired", expired: true });
  const prepared = await add({ label: "prepared", releaseStatus: "approved", itemStatus: "prepared" });
  const history = await add({ label: "history", releaseStatus: "rolled_back" });
  const member = await add({ label: "member" });
  await input.admin`
    insert into dedup_links (canonical_grant_id, member_grant_id, score, confirmed)
    values (${local.grantId}, ${member.grantId}, 1, true)
  `;
  return {
    db: drizzle(input.admin, { schema }), asOf, add,
    local, canary, production, hidden, closed, expired, prepared, history, member,
  };
}

/** UUID run에는 로컬 lab 파일이 없다. remote storage 접촉도 허용하지 않는 fixture다. */
const noObjectStorage: R2ObjectStorage = {
  async getObjectText() { throw new Error("fixture must not read remote text"); },
  async getObjectBytes() { throw new Error("fixture must not read remote bytes"); },
  async objectExists() { throw new Error("fixture must not probe remote objects"); },
  async putObject() { throw new Error("local monitor must not write production receipts"); },
  publicUrl() { throw new Error("fixture must not construct remote URLs"); },
  async presignGetUrl() { throw new Error("fixture must not sign remote URLs"); },
};

async function sealCurrentLocalMonitorFixture(
  input: { admin: postgres.Sql; db: CunoteDb; storage?: R2ObjectStorage; expectedOperationalSealed?: boolean },
  fixture: { grantId: string; releaseDbId: string; itemId: string },
) {
  const currentInput = await prepareDeepAnalysisInput({
    db: input.db, storage: input.storage ?? noObjectStorage, grantId: fixture.grantId,
  });
  assert.equal(currentInput.sealed, input.expectedOperationalSealed ?? true);
  const currentSnapshot = await loadPromotionGrantSnapshot(input.db, fixture.grantId);
  const [row] = await input.admin<{ manifest: unknown }[]>`
    select manifest from analysis_lab_promotion_releases where id=${fixture.releaseDbId}
  `;
  const prior = validatePromotionReleaseManifest(row!.manifest);
  const manifest = createPromotionReleaseManifest({
    releaseId: prior.releaseId, revision: prior.revision, createdAt: prior.createdAt,
    gitCommit: prior.gitCommit, buildDigest: prior.buildDigest, cohortLabel: prior.cohortLabel,
    canaryGrantIds: prior.canaryGrantIds, plans: prior.plans,
    sourceArtifacts: prior.sourceArtifacts.map((artifact) => ({
      ...artifact, sourceRevisionSha256: currentInput.sourceRevisionSha256,
    })),
  });
  assert.notEqual(manifest.sourceArtifacts[0]!.localLabEvidence!.inputSha256, currentInput.inputSha256,
    "local lab input과 operational input은 다른 계약이라는 회귀 조건");
  await input.admin`
    update analysis_lab_promotion_releases
    set manifest=${JSON.stringify(manifest)}::jsonb, manifest_sha256=${manifest.manifestSha256},
        release_plan_sha256=${manifest.releasePlanSha256}
    where id=${fixture.releaseDbId}
  `;
  await input.admin`
    update analysis_lab_promotion_items
    set before_snapshot=${JSON.stringify(currentSnapshot)}::jsonb,
        before_sha256=${sha256Canonical(currentSnapshot)},
        after_snapshot=${JSON.stringify(currentSnapshot)}::jsonb,
        after_sha256=${promotionGrantSnapshotStateSha256(currentSnapshot)}
    where id=${fixture.itemId}
  `;
}

export async function verifyServingMonitorPostgres(input: {
  admin: postgres.Sql;
  socket: string;
}): Promise<void> {
  const f = await seedMonitorFixtures(input);
  const read = () => loadActiveServingMonitorInventory({ db: f.db, asOf: f.asOf });
  const initial = await read();
  const canonical = await createDrizzleRepositories({ dialect: "drizzle", client: f.db })
    .grants.listActiveGrants({ asOf: f.asOf, limit: 5_001, requireDeepAnalysisPromotion: true });
  assert.deepEqual(initial.canonicalEntries, canonical, "monitor는 실제 제품 DTO를 그대로 읽는다");
  assert.equal(initial.plan.verdict, "READY", JSON.stringify(initial.plan.issues));
  assert.equal(initial.plan.admittedItems, canonical.length);
  assert.equal(new Set(initial.plan.targets.map((target) => target.binding.grantId)).size, canonical.length);
  const targetByGrant = new Map(initial.plan.targets.map((target) => [target.binding.grantId, target]));
  assert.equal(targetByGrant.get(f.local.grantId)?.binding.evidenceKind, "verified_local_lab");
  assert.equal(targetByGrant.get(f.canary.grantId)?.binding.releaseStatus, "canary_passed");
  assert.equal(targetByGrant.get(f.production.grantId)?.binding.evidenceKind, "production_deep_run");
  for (const [fixture, reason] of [
    [f.hidden, "not_visible"], [f.closed, "inactive_status"],
    [f.expired, "deadline_elapsed"], [f.member, "confirmed_duplicate"],
  ] as const) {
    assert.equal(targetByGrant.has(fixture.grantId), false);
    assert.ok(initial.plan.excluded.some((row) => row.grantId === fixture.grantId && row.reason === reason));
  }
  for (const fixture of [f.prepared, f.history]) {
    assert.equal(initial.candidates.some((candidate) => candidate.binding.grantId === fixture.grantId), false);
    assert.equal(targetByGrant.has(fixture.grantId), false);
  }
  console.log("PASS: actual monitor SQL covers local/production/canary and excludes hidden/closed/expired/dedup/history/unapplied");

  const overflow = await loadActiveServingMonitorInventory({ db: f.db, asOf: f.asOf, sentinelLimit: 1 });
  assert.equal(overflow.plan.verdict, "FAIL");
  assert.ok(overflow.plan.issues.some((issue) => issue.code === "sentinel_overflow"));
  await withPromotionServingReadSnapshot(f.db, async (session) => {
    await assert.rejects(
      () => loadActiveServingMonitorInventory({ db: session as unknown as CunoteDb, asOf: f.asOf }),
      /top-level database client/,
    );
  });

  const changedAfter = "f".repeat(64);
  await input.admin`update analysis_lab_promotion_items set after_sha256=${changedAfter} where id=${f.local.itemId}`;
  const changed = await read();
  assert.notEqual(changed.inventorySha256, initial.inventorySha256,
    "동일 item ID라도 publication after hash가 바뀌면 inventory 결속이 달라진다");
  await input.admin`update analysis_lab_promotion_items set after_sha256=${"b".repeat(64)} where id=${f.local.itemId}`;
  assert.equal((await read()).inventorySha256, initial.inventorySha256);

  const newer = await f.add({ label: "newer", grantId: f.local.grantId, appliedAt: "2026-09-09T00:03:00Z" });
  const latest = await read();
  assert.equal(latest.plan.verdict, "READY");
  assert.equal(latest.plan.targets.find((target) => target.binding.grantId === f.local.grantId)?.binding.promotionItemId, newer.itemId);
  assert.ok(latest.plan.excluded.some((row) => row.promotionItemId === f.local.itemId && row.reason === "superseded_binding"));
  const tie = await f.add({ label: "tie", grantId: f.local.grantId, appliedAt: "2026-09-09T00:03:00Z" });
  const ambiguous = await read();
  assert.equal(ambiguous.plan.verdict, "FAIL");
  assert.ok(ambiguous.plan.issues.some((issue) => issue.grantId === f.local.grantId && issue.code === "binding_latest_ambiguous"));
  assert.equal(ambiguous.plan.targets.some((target) => target.binding.grantId === f.local.grantId), false);
  await input.admin`update analysis_lab_promotion_items set status='rolled_back' where id=${tie.itemId}`;
  const missingDate = await f.add({ label: "missing-date", grantId: f.local.grantId, appliedAt: null });
  const missing = await read();
  assert.equal(missing.plan.verdict, "FAIL");
  assert.ok(missing.plan.issues.some((issue) => issue.promotionItemId === missingDate.itemId && issue.code === "binding_applied_at_missing"));
  await input.admin`update analysis_lab_promotion_items set status='rolled_back' where id=${missingDate.itemId}`;
  console.log("PASS: real monitor snapshot rejects overflow/nested transaction/ambiguous binding and detects publication binding drift");

  const states = await input.admin<{ id: string; serving_state: string }[]>`select id::text, serving_state from grants`;
  try {
    await input.admin`update grants set serving_state='suppressed'`;
    const empty = await read();
    assert.equal(empty.plan.actualServingItems, 0);
    assert.equal(empty.plan.admittedItems, 0);
    assert.equal(empty.plan.verdict, "NO_TARGETS", "실제 빈 공급도 건강한 PASS로 취급하지 않는다");
    assert.deepEqual(empty.plan.issues, []);
  } finally {
    await input.admin`
      update grants g set serving_state=s.serving_state::grant_serving_state
      from jsonb_to_recordset(${JSON.stringify(states)}::jsonb) as s(id uuid, serving_state text)
      where g.id=s.id
    `;
  }
  assert.equal((await read()).plan.verdict, "READY");
  console.log("PASS: empty canonical supply is explicit NO_TARGETS; isolated visibility fixtures restored");

  const portable = await f.add({ label: "portable-local" });
  await sealCurrentLocalMonitorFixture({ admin: input.admin, db: f.db }, portable);
  const portableInventory = await read();
  const portableTarget = portableInventory.plan.targets.find((target) => target.binding.grantId === portable.grantId);
  assert.ok(portableTarget);
  const verify = () => verifyActiveServingTarget({
    db: f.db, storage: noObjectStorage, target: portableTarget,
    monitorExecutionId: "isolated-cloud-run-local-monitor", monitorRuntime: "cloud_run",
  });
  const portableResult = await verify();
  assert.equal(portableResult.verdict, "PASS", JSON.stringify(portableResult));
  assert.equal(portableResult.freshness.status, "passed");
  const beforeLink = await read();
  const unpromotedMemberId = crypto.randomUUID();
  await input.admin`
    insert into grants (id, source, source_id, title, status, overall_confidence)
    values (${unpromotedMemberId}, 'bizinfo', ${unpromotedMemberId}, '격리 미승격 dedup member', 'open', 1)
  `;
  await input.admin`
    insert into dedup_links (canonical_grant_id, member_grant_id, score, confirmed)
    values (${portable.grantId}, ${unpromotedMemberId}, 1, true)
  `;
  assert.equal((await read()).inventorySha256, beforeLink.inventorySha256,
    "미승격 member는 canonical DTO에 없어 post-inventory hash만으로 이 변경을 감지할 수 없다");
  const changedComponent = await verify();
  assert.equal(changedComponent.publication.status, "failed",
    "대상별 RR은 과거 confirmedLinks 배열 대신 현재 DB dedup component를 읽어야 한다");
  assert.ok(changedComponent.publication.issues.some((issue) => issue.startsWith("state_hash:")));
  await input.admin`
    delete from dedup_links where canonical_grant_id=${portable.grantId} and member_grant_id=${unpromotedMemberId}
  `;
  assert.equal((await verify()).verdict, "PASS");
  console.log("PASS: publication snapshot detects a new non-serving dedup member even when canonical inventory is unchanged");
  const [portableGrant] = await input.admin<{ title: string }[]>`select title from grants where id=${portable.grantId}`;
  await input.admin`update grants set title=${`${portableGrant!.title} 원천 변경`} where id=${portable.grantId}`;
  const staleSource = await verify();
  assert.equal(staleSource.publication.status, "passed");
  assert.equal(staleSource.serving.status, "passed");
  assert.equal(staleSource.freshness.status, "failed");
  assert.ok(staleSource.freshness.issues.some((issue) => issue.includes("source revision")));
  await input.admin`update grants set title=${portableGrant!.title} where id=${portable.grantId}`;
  const driftCriterionId = crypto.randomUUID();
  await input.admin`
    insert into grant_criteria (id, grant_id, dimension, operator, value, kind, confidence, stable_key, needs_review)
    values (${driftCriterionId}, ${portable.grantId}, 'other', 'text_only',
      '{"text":"격리 드리프트 조건"}'::jsonb, 'required', 1, ${`isolated-${driftCriterionId}`}, true)
  `;
  const stalePublication = await verify();
  assert.equal(stalePublication.verdict, "FAIL");
  assert.equal(stalePublication.publication.status, "failed");
  assert.equal(stalePublication.serving.status, "not_reached");
  assert.equal(stalePublication.freshness.status, "not_reached");
  assert.ok(stalePublication.publication.issues.some((issue) => issue.startsWith("state_hash:")));
  await input.admin`delete from grant_criteria where id=${driftCriterionId}`;
  assert.equal((await verify()).verdict, "PASS");
  console.log("PASS: actual local active verifier runs without lab files/remote I/O, accepts distinct input contracts, detects source/publication drift");

  const unprepared = await f.add({ label: "local-operational-unprepared" });
  await input.admin`
    insert into grant_raw (source, source_id, payload, attachments, raw_hash, status)
    values ('bizinfo', ${unprepared.grantId}, '{}'::jsonb,
      '[{"filename":"isolated.pdf","url":"https://example.invalid/isolated.pdf"}]'::jsonb,
      ${"d".repeat(64)}, 'published')
  `;
  await sealCurrentLocalMonitorFixture({ admin: input.admin, db: f.db, expectedOperationalSealed: false }, unprepared);
  const unpreparedInventory = await read();
  const unpreparedTarget = unpreparedInventory.plan.targets.find((target) => target.binding.grantId === unprepared.grantId)!;
  const unpreparedResult = await verifyActiveServingTarget({
    db: f.db, storage: noObjectStorage, target: unpreparedTarget,
    monitorExecutionId: "isolated-local-unprepared", monitorRuntime: "cloud_run",
  });
  assert.equal(unpreparedResult.verdict, "PASS", JSON.stringify(unpreparedResult));
  await input.admin`update grant_raw set collected_at='2026-09-09T01:00:00Z' where source='bizinfo' and source_id=${unprepared.grantId}`;
  await input.admin`update grants set updated_at='2026-09-09T01:00:00Z' where id=${unprepared.grantId}`;
  const reobserved = await read();
  const reobservedEntry = reobserved.canonicalEntries.find((entry) => entry.grant.id === unprepared.grantId);
  assert.equal(reobserved.inventorySha256, unpreparedInventory.inventorySha256,
    `재관측 시각만 바뀐 경우 material source drift가 아니다: ${JSON.stringify({
      before: unpreparedTarget.entry, after: reobservedEntry,
    })}`);

  const archived = await f.add({ label: "local-archived-markdown" });
  const markdown = "격리 공고의 검증된 첨부 본문입니다.";
  const { createHash } = await import("node:crypto");
  const markdownSha256 = createHash("sha256").update(markdown).digest("hex");
  await input.admin`
    insert into grant_attachment_archives
      (source, source_id, filename, source_uri, storage_key, sha256, conversion_status,
       markdown_storage_key, markdown_sha256)
    values ('bizinfo', ${archived.grantId}, 'isolated.pdf', 'https://example.invalid/archived.pdf',
      'isolated/original', ${"a".repeat(64)}, 'converted', 'isolated/markdown', ${markdownSha256})
  `;
  let corruptMarkdown = false;
  const memoryStorage: R2ObjectStorage = {
    ...noObjectStorage,
    async getObjectText(key) {
      assert.equal(key, "isolated/markdown");
      return corruptMarkdown ? `${markdown} tampered` : markdown;
    },
  };
  await sealCurrentLocalMonitorFixture({ admin: input.admin, db: f.db, storage: memoryStorage }, archived);
  const archivedTarget = (await read()).plan.targets.find((target) => target.binding.grantId === archived.grantId)!;
  const verifyArchived = () => verifyActiveServingTarget({
    db: f.db, storage: memoryStorage, target: archivedTarget,
    monitorExecutionId: "isolated-local-material-integrity", monitorRuntime: "cloud_run",
  });
  assert.equal((await verifyArchived()).verdict, "PASS");
  corruptMarkdown = true;
  const corruptResult = await verifyArchived();
  assert.equal(corruptResult.verdict, "FAIL", "local operational 미준비 허용이 실제 저장 객체 SHA 오류를 숨기면 안 된다");
  assert.equal(corruptResult.freshness.status, "failed");
  assert.equal(corruptResult.publication.status, "passed");
  assert.equal(corruptResult.serving.status, "passed");
  console.log("PASS: local operational readiness is telemetry, observation-only timestamps are stable, actual stored-byte corruption fails freshness");
}

import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import type { CunoteDbSession } from "../db/client";
import { collectPendingSurfaceJobs, pollAndPersistSurfaceJob, type PendingSurfaceJob } from "./pollConversions";
import { enqueueDeferredAttachmentConversions, registerAttachmentConversions } from "./registerAttachmentConversions";
import { claimConversionSweepLease, releaseConversionSweepLease } from "./conversionSweepLease";
import { runConversionPollSweep } from "./pollSweep";
import { transitionSurfaceStatus } from "./surfaceConversion";
import type { ConversionClient } from "./conversionClient";

/** Invoked only inside the isolated product PostgreSQL cluster. */
export async function verifyConversionPollingPostgres(input: {
  admin: postgres.Sql;
  socket: string;
}): Promise<void> {
  const grantId = crypto.randomUUID();
  const surfaceId = crypto.randomUUID();
  const sourceId = `conversion-poll-${surfaceId}`;
  const filename = "모집 공고.pdf";
  const storageKey = `fixture/${surfaceId}.pdf`;
  const sourceSha = "a".repeat(64);
  await input.admin`insert into grants
    (id, source, source_id, title, status, serving_state, overall_confidence)
    values (${grantId}, 'kstartup', ${sourceId}, '변환 폴링 격리 공고', 'open', 'visible', 1)`;
  await input.admin`insert into grant_attachment_archives
    (source, source_id, filename, storage_key, sha256)
    values ('kstartup', ${sourceId}, ${filename}, ${storageKey}, ${sourceSha})`;
  await input.admin`insert into grant_attachment_archives
    (source, source_id, filename, source_uri, storage_key, sha256)
    values ('kstartup', ${sourceId}, ${filename}, 'https://example.invalid/older.pdf',
      ${`${storageKey}.old`}, ${"d".repeat(64)})`;
  await input.admin`insert into grant_application_surfaces
    (id, grant_id, source, source_id, type, title, format, source_attachment, extraction_status)
    values (${surfaceId}, ${grantId}, 'kstartup', ${sourceId}, 'file_template',
      ${filename}, 'pdf', ${storageKey}, 'pending')`;
  const job: PendingSurfaceJob = {
    surfaceId, source: "kstartup", sourceId, filename, format: "pdf",
    sourceAttachment: storageKey, sourceUrl: null, sha256: sourceSha,
    sourceObjectUrl: "https://example.invalid/original.pdf",
  };
  const workerSql = postgres({ host: input.socket, database: "postgres", username: "postgres",
    prepare: false, max: 4, connection: { application_name: "cunote-conversion-poll-fixture" } });
  const db = drizzle(workerSql, { schema });
  const artifact = { kind: "markdown", storageKey: `fixture/${surfaceId}.md`, url: null,
    sha256: "b".repeat(64), contentType: "text/markdown", metadata: { converter: "fixture" } };
  const cachedClient: ConversionClient = {
    enqueueJob: async () => ({ jobId: crypto.randomUUID(), status: "succeeded", cached: true,
      artifacts: [artifact] }),
    getJob: async () => { throw new Error("cache hit must not poll status"); },
    getArtifacts: async () => { throw new Error("cache hit must not fetch artifacts"); },
  };
  try {
    const [leaseRls] = await input.admin`select relrowsecurity as enabled from pg_class
      where oid='conversion_sweep_leases'::regclass`;
    assert.equal(leaseRls?.enabled, true, "automatic sweep lease is not a client table");
    const firstLease = await claimConversionSweepLease(db);
    assert.ok(firstLease);
    assert.equal(await claimConversionSweepLease(db), null, "duplicate cron cannot claim an active sweep");
    const previousServerUrl = process.env.CONVERSION_SERVER_URL;
    const previousSecret = process.env.CONVERSION_SHARED_SECRET;
    process.env.CONVERSION_SERVER_URL = "https://example.invalid";
    process.env.CONVERSION_SHARED_SECRET = "fixture-secret";
    try {
      const skipped = await runConversionPollSweep(db, { exclusive: true, budgetMs: 1_000 });
      assert.equal(skipped.skippedReason, "sweep_lease_active");
      assert.equal(skipped.pendingCount, 0, "blocked cron does not fetch or submit another batch");
    } finally {
      if (previousServerUrl === undefined) delete process.env.CONVERSION_SERVER_URL;
      else process.env.CONVERSION_SERVER_URL = previousServerUrl;
      if (previousSecret === undefined) delete process.env.CONVERSION_SHARED_SECRET;
      else process.env.CONVERSION_SHARED_SECRET = previousSecret;
    }
    assert.equal(await releaseConversionSweepLease(db, firstLease), true);
    const secondLease = await claimConversionSweepLease(db);
    assert.ok(secondLease);
    await input.admin`update conversion_sweep_leases set expires_at=now() - interval '1 second'
      where scope='current_inventory'`;
    const recoveredLease = await claimConversionSweepLease(db);
    assert.ok(recoveredLease, "expired lease can be recovered after a killed invocation");
    assert.equal(await releaseConversionSweepLease(db, secondLease), false,
      "stale runner cannot release a successor's lease");
    assert.equal(await releaseConversionSweepLease(db, recoveredLease), true);

    const selected = await collectPendingSurfaceJobs(db, { grantId, limit: 10 });
    assert.equal(selected.length, 1, "filename fallback cannot duplicate a storage-key-bound surface");
    assert.equal(selected[0]?.sha256, sourceSha, "selection binds the exact archived storage key");
    const inspectingClient: ConversionClient = {
      ...cachedClient,
      enqueueJob: async () => {
        const [active] = await input.admin`select count(*)::int as n from pg_stat_activity
          where application_name='cunote-conversion-poll-fixture'
            and state='idle in transaction'`;
        assert.equal(active?.n, 0, "remote conversion wait must not hold a DB transaction");
        return cachedClient.enqueueJob({ jobId: crypto.randomUUID(), source: "kstartup",
          sourceId, filename, sourceObjectUrl: job.sourceObjectUrl!, sha256: sourceSha });
      },
    };
    const first = await pollAndPersistSurfaceJob(db, inspectingClient, job);
    assert.equal(first.outcome, "preview_ready");
    const concurrent = await Promise.all([
      pollAndPersistSurfaceJob(db, cachedClient, job),
      pollAndPersistSurfaceJob(db, cachedClient, job),
    ]);
    assert.ok(concurrent.every((item) => item.outcome === "preview_ready"));
    const [stored] = await input.admin`select count(*)::int as artifacts,
        (select extraction_status from grant_application_surfaces where id=${surfaceId}) as status
      from document_artifacts where surface_id=${surfaceId}`;
    assert.deepEqual({ artifacts: stored?.artifacts, status: stored?.status },
      { artifacts: 1, status: "preview_ready" }, "concurrent polls reuse one artifact");

    await transitionSurfaceStatus(db, surfaceId, "failed");
    const [afterFailure] = await input.admin`select extraction_status as status
      from grant_application_surfaces where id=${surfaceId}`;
    assert.equal(afterFailure?.status, "preview_ready", "late failure cannot demote completed preview");

    await input.admin`update grant_application_surfaces set extraction_status='pending',
      updated_at='2026-01-01T00:00:00Z' where id=${surfaceId}`;
    const pendingClient: ConversionClient = {
      enqueueJob: async () => ({ jobId: crypto.randomUUID(), status: "queued", cached: false }),
      getJob: async () => null,
      getArtifacts: async () => null,
    };
    const pending = await pollAndPersistSurfaceJob(db, pendingClient, job, { maxAttempts: 1, intervalMs: 1 });
    assert.equal(pending.outcome, "pending");
    const [attempt] = await input.admin`select extraction_status as status, updated_at as updated
      from grant_application_surfaces where id=${surfaceId}`;
    assert.equal(attempt?.status, "pending");
    assert.ok(new Date(attempt!.updated).getTime() > Date.parse("2026-01-01T00:00:00Z"),
      "pending retry moves behind untouched surfaces");

    const emptyClient: ConversionClient = {
      ...cachedClient,
      enqueueJob: async () => ({ jobId: crypto.randomUUID(), status: "succeeded", cached: true,
        artifacts: [] }),
      getArtifacts: async () => ({ jobId: crypto.randomUUID(), artifacts: [] }),
    };
    const empty = await pollAndPersistSurfaceJob(db, emptyClient, job);
    assert.equal(empty.outcome, "pending", "terminal response without artifacts is not preview-ready");

    await input.admin`update grant_attachment_archives set sha256=${"c".repeat(64)}
      where source='kstartup' and source_id=${sourceId}`;
    await assert.rejects(() => pollAndPersistSurfaceJob(db, cachedClient, job), /archived source SHA changed/);
    const [afterDrift] = await input.admin`select extraction_status as status from grant_application_surfaces
      where id=${surfaceId}`;
    assert.equal(afterDrift?.status, "pending", "source drift cannot promote a stale result");

    const sourceUrl = "https://example.invalid/original.pdf";
    await input.admin`update grant_attachment_archives set sha256=${sourceSha}
      where source='kstartup' and source_id=${sourceId} and storage_key=${storageKey}`;
    await input.admin`update grant_application_surfaces set source_url=${sourceUrl}
      where id=${surfaceId}`;
    let submitted = 0;
    const postCommitClient: ConversionClient = {
      ...cachedClient,
      enqueueJob: async (request) => {
        submitted += 1;
        const [active] = await input.admin`select count(*)::int as n from pg_stat_activity
          where application_name='cunote-conversion-poll-fixture'
            and state='idle in transaction'`;
        assert.equal(active?.n, 0, "publication must commit before remote registration");
        return cachedClient.enqueueJob(request);
      },
    };
    const registered = await db.transaction(async (tx) => {
      const value = await registerAttachmentConversions(tx as unknown as CunoteDbSession, {
        grantId, source: "kstartup", sourceId,
        attachments: [{ filename, storageKey, archiveUrl: sourceUrl, sourceUri: null,
          sha256: sourceSha, detectedFormat: "pdf" }],
      });
      assert.equal(submitted, 0, "surface registration cannot call the remote service in a transaction");
      return value;
    });
    assert.equal(registered.deferredJobs.length, 1);
    const postCommit = await enqueueDeferredAttachmentConversions(db, registered.deferredJobs,
      postCommitClient);
    assert.deepEqual(postCommit, { jobsEnqueued: 0, cacheHits: 1, warnings: [] });
    assert.equal(submitted, 1);
    const [afterCommit] = await input.admin`select extraction_status as status
      from grant_application_surfaces where id=${surfaceId}`;
    assert.equal(afterCommit?.status, "preview_ready");

    const laterGrantId = crypto.randomUUID();
    const laterSurfaceId = crypto.randomUUID();
    const laterSourceId = `conversion-later-${laterSurfaceId}`;
    await input.admin`update grants set apply_start='2026-01-01T00:00:00Z',
      apply_end='2030-12-31T00:00:00Z' where id=${grantId}`;
    await input.admin`update grant_application_surfaces set extraction_status='pending',
      updated_at='2026-01-01T00:00:00Z' where id=${surfaceId}`;
    await input.admin`insert into grants
      (id, source, source_id, title, status, serving_state, overall_confidence, apply_start, apply_end)
      values (${laterGrantId}, 'kstartup', ${laterSourceId}, '후순위 마감 공고', 'open', 'visible', 1,
        '2026-01-01T00:00:00Z', '2031-01-31T00:00:00Z')`;
    await input.admin`insert into grant_attachment_archives
      (source, source_id, filename, storage_key, sha256)
      values ('kstartup', ${laterSourceId}, '사업안내.pdf', ${`fixture/${laterSurfaceId}.pdf`}, ${"e".repeat(64)})`;
    await input.admin`insert into grant_application_surfaces
      (id, grant_id, source, source_id, type, title, format, source_attachment,
        extraction_status, updated_at)
      values (${laterSurfaceId}, ${laterGrantId}, 'kstartup', ${laterSourceId}, 'file_template',
        '사업안내.pdf', 'pdf', ${`fixture/${laterSurfaceId}.pdf`}, 'pending',
        '2026-01-02T00:00:00Z')`;
    const selection = { currentOpenOnly: true, asOf: new Date("2026-09-28T00:00:00Z"), limit: 1 };
    const [oldest] = await collectPendingSurfaceJobs(db, selection);
    assert.equal(oldest?.surfaceId, surfaceId);
    await pollAndPersistSurfaceJob(db, pendingClient, { ...job, sourceUrl },
      { maxAttempts: 1, intervalMs: 1 });
    const [next] = await collectPendingSurfaceJobs(db, selection);
    assert.equal(next?.surfaceId, laterSurfaceId,
      "a repeatedly pending early deadline cannot starve another current notice");
    console.log("PASS: conversion poll releases DB during remote I/O, serializes artifacts, preserves ready state and blocks source drift");
  } finally {
    await workerSql.end({ timeout: 5 });
  }
}

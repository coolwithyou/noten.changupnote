import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement } from "@cunote/core";
import * as schema from "../db/schema";
import { publishKStartupGrants } from "../ingestion/kstartupPublisher";
import { discoverGrantSupplyWork } from "./grantSupply";

const socket = process.env.CUNOTE_PRODUCT_TEST_SOCKET ?? "";
assert.match(socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);
assert.match(realpathSync(socket), /^\/(?:private\/)?tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);
const admin = postgres({ host: socket, database: "postgres", username: "postgres", prepare: false, max: 1, onnotice: () => {} });
try {
  const [empty] = await admin`select count(*)::int as count from pg_tables where schemaname='public'`;
  assert.equal(empty!.count, 0, "전용 빈 cluster만 사용한다");
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    for (const statement of readFileSync(`db/migrations/${entry.tag}.sql`, "utf8")
      .split("--> statement-breakpoint")) {
      if (statement.trim()) await admin.unsafe(statement);
    }
  }
  const db = drizzle(admin, { schema });
  const grantId = crypto.randomUUID();
  const sourceId = `grant-supply-discovery-${grantId}`;
  const eventTime = new Date("2026-09-24T00:00:00.000Z");
  const statusTime = new Date("2026-09-24T01:00:00.000Z");
  const rawHash = "a".repeat(64);

  await admin.begin(async (tx) => {
    await tx`insert into grants
      (id, source, source_id, title, status, serving_state, overall_confidence, updated_at)
      values (${grantId}, 'bizinfo', ${sourceId}, '공급 재발견 격리 공고', 'closed', 'visible', 1, ${eventTime.toISOString()})`;
    await tx`insert into grant_raw (source, source_id, payload, raw_hash, status)
      values ('bizinfo', ${sourceId}, '{}'::jsonb, ${rawHash}, 'normalized')`;
    await tx`insert into grant_collection_events
      (source, source_id, raw_hash, revision_kind, collected_at)
      values ('bizinfo', ${sourceId}, ${rawHash}, 'new', ${eventTime.toISOString()})`;
  });

  const first = await discoverGrantSupplyWork({
    db, source: "bizinfo", since: eventTime, until: new Date("2026-09-24T00:30:00.000Z"),
    asOf: new Date("2026-09-24T02:00:00.000Z"),
  });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]?.grantId, grantId);
  assert.equal(first.items[0]?.discoveredBy, "collection_event");
  assert.equal(first.items[0]?.eventRawSha256, rawHash);
  assert.equal(first.items[0]?.status, "inactive");

  // 이벤트 500건 한도를 넘는 기간에도 source ID 합집합을 한 번씩만 처리한다.
  await admin`insert into grant_collection_events
    (source, source_id, raw_hash, revision_kind, collected_at)
    select 'bizinfo', 'discovery-page-' || lpad(n::text, 4, '0'), repeat('a', 64),
      'new', ${eventTime.toISOString()} from generate_series(1, 501) as n`;
  await admin`insert into grant_collection_events
    (source, source_id, raw_hash, revision_kind, collected_at)
    values ('bizinfo', 'discovery-page-0001', ${"b".repeat(64)}, 'changed',
      ${new Date(eventTime.getTime() + 1000).toISOString()})`;
  const pageWindow = { source: "bizinfo" as const, since: eventTime,
    until: new Date("2026-09-24T00:30:00.000Z"),
    asOf: new Date("2026-09-24T02:00:00.000Z") };
  const pageOne = await discoverGrantSupplyWork({ db, ...pageWindow });
  assert.equal(pageOne.items.length, 500);
  assert.equal(pageOne.nextCursor, "discovery-page-0500");
  assert.equal(pageOne.items[0]?.eventRawSha256, "b".repeat(64));
  const pageTwo = await discoverGrantSupplyWork({ db, ...pageWindow,
    afterSourceId: pageOne.nextCursor! });
  assert.equal(pageTwo.items.length, 2);
  assert.equal(pageTwo.nextCursor, null);
  assert.equal(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.sourceId)).size, 502);
  const repeatPageTwo = await discoverGrantSupplyWork({ db, ...pageWindow,
    afterSourceId: pageOne.nextCursor! });
  assert.deepEqual(repeatPageTwo, pageTwo, "cursor 재시작이 동일 대상과 상태를 반환한다");

  const publisherSourceId = `grant-supply-publisher-${crypto.randomUUID()}`;
  const entry: NormalizedGrant<KStartupAnnouncement> = {
    raw: {
      source: "kstartup", source_id: publisherSourceId,
      payload: { pbanc_sn: publisherSourceId, intg_pbanc_biz_nm: "공급 재발견 publisher fixture" },
      status: "published",
    },
    grant: {
      source: "kstartup", source_id: publisherSourceId, title: "공급 재발견 publisher fixture",
      status: "closed", f_regions: [], f_industries: [], f_sizes: [],
      f_founder_traits: [], f_required_certs: [], f_apply_methods: [],
      f_authoring_mode: "unknown", overall_confidence: 1, parser_version: "fixture-v1",
    },
    criteria: [],
  };
  const published = await publishKStartupGrants(db, [entry], { collectedAt: eventTime });
  assert.equal(published.revisionCounts.new, 1);
  assert.equal(published.supplyWorkItems?.[0]?.sourceId, publisherSourceId);
  const unchanged = await publishKStartupGrants(db, [entry], { collectedAt: statusTime });
  assert.equal(unchanged.revisionCounts.unchanged, 1);
  assert.equal(unchanged.supplyCandidateGrantIds.length, 0);
  assert.equal(unchanged.supplyWorkItems?.[0]?.sourceId, publisherSourceId);
  const [publisherEventCount] = await admin`select count(*)::int as count from grant_collection_events
    where source='kstartup' and source_id=${publisherSourceId}`;
  assert.equal(publisherEventCount?.count, 1);

  // 같은 raw를 재수집해 collection event가 생기지 않아도 status-only 갱신을 읽는다.
  await admin`update grants set status='unknown', updated_at=${statusTime.toISOString()} where id=${grantId}`;
  const [eventCount] = await admin`select count(*)::int as count from grant_collection_events
    where source='bizinfo' and source_id=${sourceId}`;
  assert.equal(eventCount?.count, 1);
  const restartedReader = postgres({ host: socket, database: "postgres", username: "postgres", prepare: false, max: 1 });
  try {
    const restartedDb = drizzle(restartedReader, { schema });
    const recovered = await discoverGrantSupplyWork({
      db: restartedDb, source: "bizinfo", since: statusTime, until: new Date("2026-09-24T01:30:00.000Z"),
      asOf: new Date("2026-09-24T02:00:00.000Z"),
    });
    assert.equal(recovered.items.length, 1);
    assert.equal(recovered.items[0]?.grantId, grantId);
    assert.equal(recovered.items[0]?.discoveredBy, "current_state");
    assert.equal(recovered.items[0]?.eventRawSha256, null);
    assert.equal(recovered.items[0]?.currentRawSha256, rawHash);
    assert.equal(recovered.items[0]?.status, "inactive");

    const exact = await discoverGrantSupplyWork({ db: restartedDb, source: "bizinfo", sourceIds: [sourceId] });
    assert.equal(exact.items.length, 1);
    assert.equal(exact.items[0]?.grantId, grantId);
  } finally {
    await restartedReader.end({ timeout: 5 });
  }
  console.log("PASS: committed event, publisher unchanged, and status-only state rediscovered on a new connection");
} finally {
  await admin.end({ timeout: 5 });
}

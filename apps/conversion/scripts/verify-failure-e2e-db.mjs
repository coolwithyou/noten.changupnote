#!/usr/bin/env node
// T9 (전 구간 …→R2/DB) — 실패/부분성공 job 이 웹앱 DB 상태 전이(계획 8.3)로 이어지는지 검증.
//
// 검증 대상 로직(웹앱 T8, apps/web/.../surfaceConversion.ts):
//   mapJobStatusToExtractionStatus:  failed -> "failed",  succeeded|partial -> "preview_ready"
//   transitionSurfaceStatus:         pending -> failed | preview_ready (fields_ready 는 강등 안 함)
//   upsertDocumentArtifacts:         (surfaceId, kind, page) 멱등 upsert
// 이 스크립트는 위 로직과 동일한 SQL 을 실제 DB(Supabase pooler) 에 실행해 실패 경로 전이를 확인한다.
// (웹앱 TS 를 그대로 import 하려면 @cunote/contracts·drizzle 전체 빌드가 필요하므로, 동일 SQL 로 미러.)
//
// 실행: NODE_PATH=/tmp/dk/node_modules node apps/conversion/scripts/verify-failure-e2e-db.mjs
// 전제: postgres 패키지(NODE_PATH/--sdk), DATABASE_URL(changupnote DB).
//       테스트 surface/artifact 행은 검증 후 SQL 로 삭제(테스트용 grant 는 기존 행 재사용, 삭제 안 함).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const args = process.argv.slice(2);
const sdkIdx = args.indexOf("--sdk");
const sdkPath = sdkIdx >= 0 ? args[sdkIdx + 1] : process.env.CONVERSION_SDK_PATH ?? "/tmp/dk/node_modules";
const sdkRequire = createRequire(join(resolve(sdkPath), "noop.js"));
const postgres = sdkRequire("postgres");

function loadEnv(file) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* noop */ }
}
loadEnv(join(REPO_ROOT, ".env"));
loadEnv(join(REPO_ROOT, ".env.local"));

const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!DB_URL) { console.error("DATABASE_URL 미설정"); process.exit(2); }

// 웹앱 로직 미러 (apps/web/.../surfaceConversion.ts).
function mapJobStatusToExtractionStatus(status) {
  if (status === "succeeded" || status === "partial") return "preview_ready";
  if (status === "failed") return "failed";
  return "pending";
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
}

const sql = postgres(DB_URL, { prepare: false, max: 1 });
const TAG = `t9-e2e-${Date.now()}`;
const createdSurfaceIds = [];

async function makeSurface(grantId, title, extractionStatus = "pending") {
  const id = randomUUID();
  await sql`
    insert into grant_application_surfaces
      (id, grant_id, source, source_id, type, title, format, source_url, source_attachment, extraction_status, extraction_version)
    values
      (${id}, ${grantId}, ${"kstartup"}, ${"T9_" + TAG}, ${"file_template"}, ${title}, ${"hwp"},
       ${"local://" + title}, ${TAG + "/" + title}, ${extractionStatus}, ${"conv-2026.07-lo26.2-h2o0.7.13"})`;
  createdSurfaceIds.push(id);
  return id;
}
async function surfaceStatus(id) {
  const r = await sql`select extraction_status s from grant_application_surfaces where id = ${id}`;
  return r[0]?.s;
}
// transitionSurfaceStatus 미러: fields_ready 면 강등 안 함.
async function transition(id, next) {
  const cur = await surfaceStatus(id);
  if (cur === "fields_ready") return;
  await sql`update grant_application_surfaces set extraction_status = ${next}, updated_at = now() where id = ${id}`;
}
// upsertDocumentArtifacts 미러: (surface_id, kind, page) 멱등.
async function upsertArtifacts(surfaceId, artifacts) {
  let inserted = 0, updated = 0;
  for (const a of artifacts) {
    const page = a.page ?? null;
    const existing = page === null
      ? await sql`select id from document_artifacts where surface_id = ${surfaceId} and kind = ${a.kind} and page is null limit 1`
      : await sql`select id from document_artifacts where surface_id = ${surfaceId} and kind = ${a.kind} and page = ${page} limit 1`;
    if (existing[0]) {
      await sql`update document_artifacts set storage_key = ${a.storageKey}, url = ${a.url ?? null}, content_type = ${a.contentType ?? null}, sha256 = ${a.sha256 ?? null}, metadata = ${sql.json(a.metadata ?? {})} where id = ${existing[0].id}`;
      updated += 1;
    } else {
      await sql`insert into document_artifacts (surface_id, kind, page, storage_key, url, content_type, sha256, metadata) values (${surfaceId}, ${a.kind}, ${page}, ${a.storageKey}, ${a.url ?? null}, ${a.contentType ?? null}, ${a.sha256 ?? null}, ${sql.json(a.metadata ?? {})})`;
      inserted += 1;
    }
  }
  return { inserted, updated };
}
async function artifactCount(surfaceId) {
  const r = await sql`select count(*)::int c from document_artifacts where surface_id = ${surfaceId}`;
  return r[0].c;
}

// 웹앱 pollAndPersistSurfaceJob 의 종단 분기 미러:
//   failed        -> transition(failed), artifact upsert 안 함
//   succeeded/partial -> upsert artifacts + transition(preview_ready)
async function persistJobOutcome(surfaceId, jobStatus, artifacts) {
  if (jobStatus === "failed") {
    await transition(surfaceId, "failed");
    return { outcome: "failed", inserted: 0, updated: 0 };
  }
  const up = await upsertArtifacts(surfaceId, artifacts);
  await transition(surfaceId, mapJobStatusToExtractionStatus(jobStatus));
  return { outcome: "preview_ready", ...up };
}

async function main() {
  let exitCode = 0;
  try {
    const grants = await sql`select id from grants limit 1`;
    if (!grants[0]) { console.error("grants 행이 없어 테스트 surface 를 만들 수 없음"); process.exit(2); }
    const grantId = grants[0].id;
    console.log(`[T9-e2e-db] DB=changupnote grant=${grantId} tag=${TAG}\n`);

    // --- 1) 실패 job → surface failed, artifact 0건 ---
    const failedSurface = await makeSurface(grantId, "failed-case");
    check("초기 상태 pending", (await surfaceStatus(failedSurface)) === "pending");
    const r1 = await persistJobOutcome(failedSurface, "failed", []);
    check("실패 job → surface extraction_status=failed", (await surfaceStatus(failedSurface)) === "failed");
    check("실패 job → artifact 0건", (await artifactCount(failedSurface)) === 0);
    check("실패 job → outcome=failed", r1.outcome === "failed");

    // --- 2) 부분성공 job → preview_ready, pdf+page_image artifact 만 upsert(markdown 없음) ---
    const partialSurface = await makeSurface(grantId, "partial-case");
    const partialArtifacts = [
      { kind: "pdf", page: null, storageKey: `${TAG}/pdf`, url: "https://x/pdf", contentType: "application/pdf", sha256: "a".repeat(64), metadata: { pageCount: 1 } },
      { kind: "page_image", page: 1, storageKey: `${TAG}/p001`, url: "https://x/p1", contentType: "image/png", sha256: "b".repeat(64), metadata: { dpi: 220 } },
    ];
    const r2 = await persistJobOutcome(partialSurface, "partial", partialArtifacts);
    check("부분성공 job → surface extraction_status=preview_ready", (await surfaceStatus(partialSurface)) === "preview_ready");
    check("부분성공 job → artifact 2건(pdf+page_image)", (await artifactCount(partialSurface)) === 2, `실제=${await artifactCount(partialSurface)}`);
    check("부분성공 job → inserted=2", r2.inserted === 2);
    const mdCount = (await sql`select count(*)::int c from document_artifacts where surface_id = ${partialSurface} and kind = ${"markdown"}`)[0].c;
    check("부분성공 job → markdown artifact 없음", mdCount === 0);

    // --- 3) 멱등: 같은 artifact 재upsert → update(중복 insert 안 함) ---
    const r3 = await upsertArtifacts(partialSurface, partialArtifacts);
    check("artifact 재upsert 멱등 → updated=2, inserted=0", r3.updated === 2 && r3.inserted === 0, `ins=${r3.inserted} upd=${r3.updated}`);
    check("artifact 재upsert 후에도 2건 유지", (await artifactCount(partialSurface)) === 2);

    // --- 4) 강등 방지: fields_ready surface 는 failed 로 강등되지 않음 ---
    const frSurface = await makeSurface(grantId, "fields-ready-case", "fields_ready");
    await persistJobOutcome(frSurface, "failed", []);
    check("fields_ready → failed 강등 안 함", (await surfaceStatus(frSurface)) === "fields_ready", `실제=${await surfaceStatus(frSurface)}`);

    console.log(`\n[T9-e2e-db] 통과 ${passed} / 실패 ${failed}`);
    if (failed > 0) exitCode = 1;
  } finally {
    // 정리: 테스트 surface/artifact 삭제(artifact 는 FK cascade). grant 는 재사용이므로 삭제 안 함.
    for (const id of createdSurfaceIds) {
      try {
        await sql`delete from document_artifacts where surface_id = ${id}`;
        await sql`delete from grant_application_surfaces where id = ${id}`;
      } catch (e) { console.log(`  [cleanup] surface ${id} 삭제 실패: ${e.message}`); }
    }
    await sql.end();
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });

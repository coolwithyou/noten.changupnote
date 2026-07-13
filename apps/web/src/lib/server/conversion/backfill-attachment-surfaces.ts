/**
 * 아카이브 첨부 → surface 소급 등록 백필 (마스터 설계 Phase 1 "기존 attachment archive 와 연결",
 * 계획 docs/plans/2026-07-08-ideal-flow-vertical-slice.md 슬라이스 A 후속).
 *
 * 배경: bizinfo 첨부는 구 파이프라인이 R2 아카이브(sha256/storage_key)까지 끝냈지만,
 * surface 등록 후크(registerAttachmentConversions, Phase 2 T7)가 생기기 전 수집분이라
 * grant_application_surfaces 가 0건이다. 이 백필은 **기존 후크를 그대로 재사용**해
 * 아카이브 완료 첨부에 surface 를 만들고 변환 job 까지 등록한다(env 미설정이면 pending 만 생성).
 *
 * 대상 선정:
 *   - grant_attachment_archives: sha256/storage_key 확보분 (R2 아카이브 완료)
 *   - 대응 grants(source, source_id) 존재 + 기본 status='open' (--all 로 전체)
 *   - 포맷 필터는 후크 내부(detectConvertibleSurfaceFormat 확장자 폴백)가 담당 —
 *     여기서 미리 거르지 않는다(스킵 집계는 후크 결과로 확인)
 *
 * 멱등: upsertApplicationSurface 가 (source, sourceId, type, sourceAttachment) 로 upsert 하므로
 * 재실행해도 중복 surface 가 생기지 않는다. 이미 surface 가 있는 grant 는 --skip-existing(기본)으로
 * 건너뛴다.
 *
 * 기본은 dry-run. --write 로 실제 등록.
 *
 * 사용:
 *   pnpm backfill:attachment-surfaces                          # dry-run (limit 5 grants)
 *   pnpm backfill:attachment-surfaces -- --write --confirm=REGISTER_ATTACHMENT_SURFACES --limit=5
 *   pnpm backfill:attachment-surfaces -- --source=bizinfo --all --limit=100 --write --confirm=REGISTER_ATTACHMENT_SURFACES
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { GrantSource } from "@cunote/contracts";
import { closeCunoteDb, getCunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  registerAttachmentConversions,
  type ArchivedAttachmentRef,
} from "./registerAttachmentConversions";

loadMonorepoEnv();

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

const write = process.argv.includes("--write");
const includeAllStatuses = process.argv.includes("--all");
const limit = boundedInteger(readArg("limit"), 5, 1, 500);
const source = (readArg("source") ?? "bizinfo") as GrantSource;
const sourceIds = csvArg(readArg("sourceIds"), 100);
if (!["bizinfo", "kstartup", "bizinfo_event"].includes(source)) {
  console.error(`지원하지 않는 source: ${source}`);
  process.exit(1);
}
if (write && readArg("confirm") !== "REGISTER_ATTACHMENT_SURFACES") {
  throw new Error("--write requires --confirm=REGISTER_ATTACHMENT_SURFACES");
}

const db = getCunoteDb();

interface GrantGroup {
  grantId: string;
  sourceId: string;
  title: string;
  attachments: ArchivedAttachmentRef[];
}

try {
  // 1) 아카이브 완료 첨부 + 대응 grant 조인. grant 당 그룹핑해 limit 적용.
  const rows = await db
    .select({
      grantId: schema.grants.id,
      grantTitle: schema.grants.title,
      grantStatus: schema.grants.status,
      sourceId: schema.grantAttachmentArchives.sourceId,
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      archiveUrl: schema.grantAttachmentArchives.archiveUrl,
      sourceUri: schema.grantAttachmentArchives.sourceUri,
      sha256: schema.grantAttachmentArchives.sha256,
    })
    .from(schema.grantAttachmentArchives)
    .innerJoin(
      schema.grants,
      and(
        eq(schema.grants.source, schema.grantAttachmentArchives.source),
        eq(schema.grants.sourceId, schema.grantAttachmentArchives.sourceId),
      ),
    )
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, source),
        isNotNull(schema.grantAttachmentArchives.sha256),
        isNotNull(schema.grantAttachmentArchives.storageKey),
        ...(includeAllStatuses ? [] : [eq(schema.grants.status, "open")]),
        ...(sourceIds.length ? [inArray(schema.grantAttachmentArchives.sourceId, sourceIds)] : []),
      ),
    )
    // 최근 갱신분부터 (archives 테이블에는 updatedAt 만 있다).
    .orderBy(desc(schema.grantAttachmentArchives.updatedAt));

  // 이미 surface 가 있는 grant 는 스킵(재조정은 poll 스윕 몫).
  const existingSurfaceSourceIds = new Set(
    (
      await db
        .select({ sourceId: schema.grantApplicationSurfaces.sourceId })
        .from(schema.grantApplicationSurfaces)
        .where(eq(schema.grantApplicationSurfaces.source, source))
    ).map((row) => row.sourceId),
  );

  const groups = new Map<string, GrantGroup>();
  for (const row of rows) {
    if (existingSurfaceSourceIds.has(row.sourceId)) continue;
    if (!groups.has(row.sourceId) && groups.size >= limit) continue;
    const group = groups.get(row.sourceId) ?? {
      grantId: row.grantId,
      sourceId: row.sourceId,
      title: row.grantTitle,
      attachments: [],
    };
    group.attachments.push({
      filename: row.filename,
      storageKey: row.storageKey,
      archiveUrl: row.archiveUrl,
      sourceUri: row.sourceUri,
      sha256: row.sha256,
      // detectedFormat 생략: 후크가 확장자로 폴백. 위장 파일은 변환 서버가 재검증한다.
    });
    groups.set(row.sourceId, group);
  }

  const summary = {
    ok: true,
    dryRun: !write,
    source,
    grantStatusFilter: includeAllStatuses ? "all" : "open",
    limit,
    sourceIds,
    candidateGrants: groups.size,
    results: [] as Array<Record<string, unknown>>,
    totals: { surfacesUpserted: 0, jobsEnqueued: 0, cacheHits: 0, skipped: 0, warnings: 0 },
  };

  for (const group of groups.values()) {
    if (!write) {
      summary.results.push({
        sourceId: group.sourceId,
        title: group.title,
        attachmentCount: group.attachments.length,
        action: "dry-run (미실행)",
      });
      continue;
    }
    const hook = await db.transaction((tx) =>
      registerAttachmentConversions(tx as unknown as CunoteDbSession, {
        grantId: group.grantId,
        source,
        sourceId: group.sourceId,
        attachments: group.attachments,
      }),
    );
    summary.totals.surfacesUpserted += hook.surfacesUpserted;
    summary.totals.jobsEnqueued += hook.jobsEnqueued;
    summary.totals.cacheHits += hook.cacheHits;
    summary.totals.skipped += hook.skipped;
    summary.totals.warnings += hook.warnings.length;
    summary.results.push({
      sourceId: group.sourceId,
      title: group.title,
      attachmentCount: group.attachments.length,
      ...hook,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: pnpm backfill:attachment-surfaces -- [options]

R2 아카이브가 끝난 첨부(sha256/storage_key 확보)에 surface 를 소급 등록하고
변환 job 을 등록한다. 기존 후크(registerAttachmentConversions)를 재사용하며 멱등이다.

Options:
  --write --confirm=REGISTER_ATTACHMENT_SURFACES
                     실제 등록 (기본 dry-run)
  --limit=5          처리할 grant 수 (1..500)
  --source=bizinfo   bizinfo|kstartup|bizinfo_event
  --sourceIds=id1,id2 특정 공고 source_id만 처리 (최대 100)
  --all              open 외 상태의 grant 도 포함
`);
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}

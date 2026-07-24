// HWP/HWPX 첨부 markdown 백필 CLI — 변환 서버 동기 엔드포인트(/v1/hwp-markdown) 이용.
//
// 배경(2026-07-24 실측): Vercel 인제스트 환경에는 pyhwp(hwp5html)가 없어 hwp/hwpx 첨부의
// markdown 변환이 전부 실패·미시도로 남았다(전체 2,186건 중 변환 완료 416건).
// grant_attachment_archives 에서 markdown 미생성 행을 골라 R2 presigned GET → 원격 변환 →
// 기존 규약(objectKey/renderArchivedMarkdown)대로 R2 업로드 → 행 UPDATE 로 소급 채운다.
// markdown_storage_key IS NULL 조건이 대상 선별이므로 재실행해도 멱등이다.
//
// 실행 (dry-run 기본):
//   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
//     apps/web/src/lib/server/ingestion/backfill-attachment-markdown.ts \
//     [--write] [--limit=20] [--source=kstartup] [--source-id=178352]
import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { objectKey, renderArchivedMarkdown, stripExtension } from "./grantAttachmentArchive";
import { createRemoteHwpMarkdownFromEnv } from "./remoteHwpMarkdown";

loadMonorepoEnv();

const GRANT_SOURCES = ["kstartup", "bizinfo", "bizinfo_event"] as const;
type BackfillSource = (typeof GRANT_SOURCES)[number];

const write = process.argv.includes("--write");
const limit = boundedInteger(readArg("limit"), 20, 1, 2_000);
const source = sourceArg(readArg("source"));
const sourceId = readArg("source-id");

const archives = schema.grantAttachmentArchives;
const hwpFilenamePattern = String.raw`\.(hwp|hwpx)$`;
const conditions: SQL[] = [
  isNull(archives.markdownStorageKey),
  isNotNull(archives.storageKey),
  // 대상은 hwp/hwpx 확장자만 — 원격 엔드포인트 계약과 동일한 범위.
  sql`${archives.filename} ~* ${hwpFilenamePattern}`,
];
if (source) conditions.push(eq(archives.source, source));
if (sourceId) conditions.push(eq(archives.sourceId, sourceId));
const where = and(...conditions);

const db = getCunoteDb();
try {
  const [countRow] = await db
    .select({ totalCandidateCount: sql<number>`count(*)::int` })
    .from(archives)
    .where(where);
  const totalCandidateCount = countRow?.totalCandidateCount ?? 0;
  const rows = await db
    .select({
      id: archives.id,
      source: archives.source,
      sourceId: archives.sourceId,
      filename: archives.filename,
      sourceUri: archives.sourceUri,
      archiveUrl: archives.archiveUrl,
      storageKey: archives.storageKey,
      sha256: archives.sha256,
      bytes: archives.bytes,
      conversionStatus: archives.conversionStatus,
    })
    .from(archives)
    .where(where)
    .orderBy(asc(archives.source), asc(archives.sourceId), asc(archives.filename))
    .limit(limit);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: write ? "write" : "dry-run",
    filters: { source: source ?? null, sourceId: sourceId ?? null },
    limit,
    totalCandidateCount,
    batchCandidateCount: rows.length,
    candidates: rows.map((row) => ({
      id: row.id,
      source: row.source,
      sourceId: row.sourceId,
      filename: row.filename,
      bytes: row.bytes,
      previousStatus: row.conversionStatus,
    })),
  };

  if (!write) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 storage configuration is required for --write");
    const remote = createRemoteHwpMarkdownFromEnv();
    if (!remote) {
      throw new Error("CONVERSION_SERVER_URL / CONVERSION_SHARED_SECRET are required for --write");
    }
    const results: Array<Record<string, unknown>> = [];
    for (const [index, row] of rows.entries()) {
      const label = `${row.source}/${row.sourceId}/${row.filename}`;
      try {
        if (!row.storageKey) throw new Error("storage_key is missing");
        const sourceObjectUrl = await storage.presignGetUrl(row.storageKey);
        const converted = await remote.convert({
          filename: row.filename,
          sourceObjectUrl,
          ...(row.sha256 ? { sha256: row.sha256 } : {}),
        });
        const markdownBody = renderArchivedMarkdown({
          source: row.source,
          sourceId: row.sourceId,
          filename: row.filename,
          originalUrl: row.sourceUri,
          archiveUrl: row.archiveUrl ?? storage.publicUrl(row.storageKey),
          markdown: converted.markdown,
        });
        const markdownSha256 = createHash("sha256").update(markdownBody).digest("hex");
        const markdownKey = objectKey({
          source: row.source,
          sourceId: row.sourceId,
          filename: `${stripExtension(row.filename)}.md`,
          sha256: markdownSha256,
          kind: "markdown",
        });
        const uploaded = await storage.putObject({
          key: markdownKey,
          body: markdownBody,
          contentType: "text/markdown; charset=utf-8",
        });
        const now = new Date();
        const [updated] = await db
          .update(archives)
          .set({
            conversionStatus: "converted",
            markdownUrl: uploaded.url,
            markdownStorageKey: uploaded.key,
            markdownSha256,
            markdownBytes: Buffer.byteLength(markdownBody),
            converter: converted.converter,
            convertedAt: now,
            conversionError: null,
            updatedAt: now,
          })
          // 후보 조회 뒤 다른 프로세스가 먼저 변환한 경우 그 결과를 덮어쓰지 않는다.
          // markdown 객체 키는 content-addressed라 같은 입력의 재업로드도 안전하다.
          .where(and(eq(archives.id, row.id), isNull(archives.markdownStorageKey)))
          .returning({ id: archives.id });
        if (!updated) {
          results.push({
            id: row.id,
            source: row.source,
            sourceId: row.sourceId,
            filename: row.filename,
            previousStatus: row.conversionStatus,
            outcome: "skipped_already_converted",
          });
          console.error(`[${index + 1}/${rows.length}] skipped ${label}: already converted`);
          continue;
        }
        results.push({
          id: row.id,
          source: row.source,
          sourceId: row.sourceId,
          filename: row.filename,
          previousStatus: row.conversionStatus,
          outcome: "converted",
          markdownStorageKey: uploaded.key,
          markdownBytes: Buffer.byteLength(markdownBody),
          converter: converted.converter,
        });
        console.error(`[${index + 1}/${rows.length}] converted ${label}`);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        results.push({
          id: row.id,
          source: row.source,
          sourceId: row.sourceId,
          filename: row.filename,
          previousStatus: row.conversionStatus,
          outcome: "failed",
          error: message,
        });
        console.error(`[${index + 1}/${rows.length}] failed ${label}: ${message}`);
      }
    }
    console.log(JSON.stringify({
      ...report,
      succeededCount: results.filter((result) => result.outcome === "converted").length,
      skippedCount: results.filter((result) => result.outcome === "skipped_already_converted").length,
      failedCount: results.filter((result) => result.outcome === "failed").length,
      results,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const eqPrefix = `--${name}=`;
  const eqForm = process.argv.find((argument) => argument.startsWith(eqPrefix))?.slice(eqPrefix.length);
  if (eqForm !== undefined) return eqForm;
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  if (next !== undefined && !next.startsWith("--")) return next;
  return undefined;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  }
  return parsed;
}

function sourceArg(value: string | undefined): BackfillSource | undefined {
  if (value === undefined) return undefined;
  if ((GRANT_SOURCES as readonly string[]).includes(value)) return value as BackfillSource;
  throw new Error(`Invalid --source: ${value} (expected ${GRANT_SOURCES.join("|")})`);
}

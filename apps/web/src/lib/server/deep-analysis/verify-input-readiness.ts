import { sql } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { activeDeepAnalysisGrantPredicate } from "./eligibility";

interface ReadinessRow extends Record<string, unknown> {
  source: string;
  attachment_id: string;
  source_id: string;
  filename: string;
  storage_key: string | null;
  sha256: string | null;
  markdown_key: string | null;
  markdown_sha256: string | null;
}

loadMonorepoEnv();
const db = getCunoteDb();

try {
  const predicate = activeDeepAnalysisGrantPredicate(new Date());
  const rows = await db.execute<ReadinessRow>(sql`
    WITH active AS (
      SELECT grants.id, grants.source, grants.source_id
      FROM grants
      WHERE ${predicate}
    ),
    converted AS (
      SELECT DISTINCT ON (surface.source, surface.source_id, surface.source_attachment)
        surface.source,
        surface.source_id,
        surface.source_attachment,
        artifact.storage_key,
        artifact.sha256
      FROM grant_application_surfaces surface
      JOIN document_artifacts artifact
        ON artifact.surface_id = surface.id AND artifact.kind = 'markdown'
      ORDER BY
        surface.source,
        surface.source_id,
        surface.source_attachment,
        artifact.created_at DESC
    )
    SELECT
      active.source::text AS source,
      archive.id::text AS attachment_id,
      active.source_id,
      archive.filename,
      archive.storage_key,
      archive.sha256,
      coalesce(archive.markdown_storage_key, converted.storage_key) AS markdown_key,
      coalesce(archive.markdown_sha256, converted.sha256) AS markdown_sha256
    FROM active
    JOIN grant_attachment_archives archive
      ON archive.source = active.source AND archive.source_id = active.source_id
    LEFT JOIN converted
      ON converted.source = archive.source
      AND converted.source_id = archive.source_id
      AND converted.source_attachment = archive.storage_key
    WHERE lower(archive.filename) ~ '\\.(hwp|hwpx)$'
    ORDER BY active.source, active.source_id, archive.filename
  `);
  const blockers = rows.flatMap((row) => {
    if (!row.storage_key || !row.sha256) {
      return [{
        attachmentId: row.attachment_id,
        source: row.source,
        sourceId: row.source_id,
        filename: row.filename,
        code: "blocked_fetch",
      }];
    }
    if (!row.markdown_key || !row.markdown_sha256) {
      return [{
        attachmentId: row.attachment_id,
        source: row.source,
        sourceId: row.source_id,
        filename: row.filename,
        code: "blocked_conversion",
      }];
    }
    return [];
  });
  const readyCount = rows.length - blockers.length;
  const report = {
    schema: "active-deep-analysis-input-readiness-v1",
    generatedAt: new Date().toISOString(),
    hwpAttachmentCount: rows.length,
    readyCount,
    blockedFetchCount: blockers.filter((item) => item.code === "blocked_fetch").length,
    blockedConversionCount: blockers.filter((item) => item.code === "blocked_conversion").length,
    conservationPassed: rows.length === readyCount + blockers.length,
    blockerCount: blockers.length,
    blockers,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.conservationPassed) process.exitCode = 2;
} finally {
  await closeCunoteDb();
}

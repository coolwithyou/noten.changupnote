import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { activeDeepAnalysisGrantPredicate } from "./eligibility";
import {
  buildActiveDeepAnalysisBaselineReport,
  emptySourceBaseline,
  type ActiveDeepAnalysisSourceBaseline,
} from "./baseline";

type BaselineRow = Record<string, unknown> & {
  source: string;
  active_count: number;
  active_with_hwp_count: number;
  hwp_attachment_count: number;
  hwp_archived_count: number;
  hwp_converted_count: number;
  hwp_failed_count: number;
  criteria_grant_count: number;
  deep_criteria_grant_count: number;
};

type CountRow = Record<string, unknown> & {
  value: number;
};

loadMonorepoEnv();

const asOf = dateArg(readArg("as-of")) ?? new Date();
const stdoutOnly = process.argv.includes("--stdout-only");
const outputPath = readArg("output") ?? defaultOutputPath(asOf);
const db = getCunoteDb();

try {
  const activePredicate = activeDeepAnalysisGrantPredicate(asOf);
  const rows = await db.execute<BaselineRow>(sql`
    WITH active AS (
      SELECT grants.id, grants.source, grants.source_id
      FROM grants
      WHERE ${activePredicate}
    ),
    hwp AS (
      SELECT
        a.source,
        a.source_id,
        count(*)::int AS attachment_count,
        count(*) FILTER (WHERE a.storage_key IS NOT NULL)::int AS archived_count,
        count(*) FILTER (
          WHERE a.markdown_storage_key IS NOT NULL
            AND a.conversion_status = 'converted'
        )::int AS converted_count,
        count(*) FILTER (WHERE a.conversion_status = 'failed')::int AS failed_count
      FROM grant_attachment_archives a
      WHERE lower(a.filename) ~ '\\.(hwp|hwpx)$'
      GROUP BY a.source, a.source_id
    ),
    criteria AS (
      SELECT
        grant_id,
        count(*)::int AS criterion_count,
        count(*) FILTER (
          WHERE parser_version = 'analysis-lab-shadow-v1'
             OR parser_version LIKE 'lab-deep-%'
        )::int AS deep_count
      FROM grant_criteria
      GROUP BY grant_id
    )
    SELECT
      active.source::text AS source,
      count(*)::int AS active_count,
      count(*) FILTER (WHERE coalesce(hwp.attachment_count, 0) > 0)::int
        AS active_with_hwp_count,
      coalesce(sum(hwp.attachment_count), 0)::int AS hwp_attachment_count,
      coalesce(sum(hwp.archived_count), 0)::int AS hwp_archived_count,
      coalesce(sum(hwp.converted_count), 0)::int AS hwp_converted_count,
      coalesce(sum(hwp.failed_count), 0)::int AS hwp_failed_count,
      count(*) FILTER (WHERE coalesce(criteria.criterion_count, 0) > 0)::int
        AS criteria_grant_count,
      count(*) FILTER (WHERE coalesce(criteria.deep_count, 0) > 0)::int
        AS deep_criteria_grant_count
    FROM active
    LEFT JOIN hwp
      ON hwp.source = active.source AND hwp.source_id = active.source_id
    LEFT JOIN criteria ON criteria.grant_id = active.id
    GROUP BY active.source
    ORDER BY active.source
  `);
  const [releaseRow] = await db.execute<CountRow>(sql`
    SELECT count(*)::int AS value
    FROM analysis_lab_promotion_releases
  `);

  const bySource = Object.fromEntries(rows.map((row) => [
    row.source,
    toSourceBaseline(row),
  ]));
  const report = buildActiveDeepAnalysisBaselineReport({
    generatedAt: new Date().toISOString(),
    bySource,
    promotionReleaseCount: releaseRow?.value ?? 0,
  });

  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (!stdoutOnly) {
    const absolute = resolve(outputPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, rendered, { encoding: "utf8", flag: "wx" });
    console.error(`[deep-analysis] baseline artifact: ${absolute}`);
  }
  process.stdout.write(rendered);
  if (!report.conservation.passed) process.exitCode = 2;
} finally {
  await closeCunoteDb();
}

function toSourceBaseline(row: BaselineRow): ActiveDeepAnalysisSourceBaseline {
  return {
    ...emptySourceBaseline(),
    activeCount: Number(row.active_count),
    activeWithHwpCount: Number(row.active_with_hwp_count),
    hwpAttachmentCount: Number(row.hwp_attachment_count),
    hwpArchivedCount: Number(row.hwp_archived_count),
    hwpConvertedCount: Number(row.hwp_converted_count),
    hwpFailedCount: Number(row.hwp_failed_count),
    criteriaGrantCount: Number(row.criteria_grant_count),
    deepCriteriaGrantCount: Number(row.deep_criteria_grant_count),
  };
}

function defaultOutputPath(asOf: Date): string {
  const stamp = asOf.toISOString().replace(/[:.]/g, "-");
  return `spike-out/deep-analysis/baselines/active-${stamp}.json`;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

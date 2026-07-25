import { sql } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { putImmutableDeepAnalysisArtifact } from "./artifacts";
import { sha256Hex, stableJson } from "./sourceRevision";

interface LedgerCatalogRow extends Record<string, unknown> {
  table_count: number;
  rls_count: number;
  append_only_trigger_count: number;
  identity_trigger_count: number;
  promotion_fk_count: number;
}

interface GrantRow extends Record<string, unknown> {
  id: string;
}

loadMonorepoEnv();

const writeR2 = process.argv.includes("--write-r2");
const db = getCunoteDb();

try {
  const [catalog] = await db.execute<LedgerCatalogRow>(sql`
    SELECT
      (
        SELECT count(*)::int
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name LIKE 'grant_deep_analysis_%'
      ) AS table_count,
      (
        SELECT count(*)::int
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname LIKE 'grant_deep_analysis_%'
          AND relrowsecurity
      ) AS rls_count,
      (
        SELECT count(*)::int
        FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN (
            'grant_deep_analysis_stage_receipts_append_only',
            'grant_deep_analysis_axis_results_append_only',
            'grant_deep_analysis_audits_append_only',
            'grant_deep_analysis_exception_events_append_only'
          )
      ) AS append_only_trigger_count,
      (
        SELECT count(*)::int
        FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = 'grant_deep_analysis_runs_identity_guard'
      ) AS identity_trigger_count,
      (
        SELECT count(*)::int
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'analysis_lab_promotion_items'
          AND constraint_type = 'FOREIGN KEY'
          AND constraint_name LIKE 'analysis_lab_promotion_items_deep_analysis_run_id%'
      ) AS promotion_fk_count
  `);
  if (!catalog) throw new Error("Deep analysis ledger catalog query returned no row");
  const normalized = {
    tableCount: Number(catalog.table_count),
    rlsCount: Number(catalog.rls_count),
    appendOnlyTriggerCount: Number(catalog.append_only_trigger_count),
    identityTriggerCount: Number(catalog.identity_trigger_count),
    promotionFkCount: Number(catalog.promotion_fk_count),
  };
  if (
    normalized.tableCount !== 7
    || normalized.rlsCount !== 7
    || normalized.appendOnlyTriggerCount !== 4
    || normalized.identityTriggerCount !== 1
    || normalized.promotionFkCount !== 1
  ) {
    throw new Error(`Deep analysis ledger catalog mismatch: ${JSON.stringify(normalized)}`);
  }

  let r2: {
    key: string;
    sha256: string;
    bytes: number;
    reused: boolean;
  } | null = null;
  if (writeR2) {
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 configuration is required for --write-r2");
    const [grant] = await db.execute<GrantRow>(sql`
      SELECT id::text AS id
      FROM grants
      ORDER BY updated_at DESC, id
      LIMIT 1
    `);
    if (!grant) throw new Error("A grant is required for the R2 ledger verifier");
    const body = `${stableJson({
      schema: "deep-analysis-ledger-r2-verifier-v1",
      generatedAt: new Date().toISOString(),
      checks: normalized,
    })}\n`;
    r2 = await putImmutableDeepAnalysisArtifact({
      storage,
      identity: {
        grantId: grant.id,
        sourceRevisionSha256: sha256Hex("deep-analysis-ledger-r2-verifier-v1"),
        runId: "ledger-verifier-20260725-b2",
        kind: "stage-evidence",
        extension: "json",
      },
      body,
      contentType: "application/json",
    });
  }

  process.stdout.write(`${JSON.stringify({
    schema: "deep-analysis-ledger-production-verification-v1",
    writeMode: writeR2,
    catalog: normalized,
    r2,
    passed: true,
  }, null, 2)}\n`);
} finally {
  await closeCunoteDb();
}

/** exact 공고 또는 bounded source/기간의 미완료 공급 단계를 읽기 전용으로 재발견한다. */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import {
  discoverGrantSupplyWork,
  loadCurrentGrantSupplySnapshot,
  loadStoredGrantSupplyAssets,
  planGrantSupply,
} from "./grantSupply";

async function main(): Promise<void> {
  const grantId = argument("--grant-id=");
  const source = argument("--source=");
  const sourceId = argument("--source-id=");
  const sinceText = argument("--since=");
  const untilText = argument("--until=");
  const afterSourceId = argument("--after-source-id=");
  if ((grantId === undefined) === (source === undefined)) {
    throw new Error("--grant-id=<UUID> 또는 --source=bizinfo|kstartup 중 하나를 지정해야 합니다.");
  }
  if (source !== undefined && source !== "bizinfo" && source !== "kstartup") {
    throw new Error("--source는 bizinfo 또는 kstartup이어야 합니다.");
  }
  if (grantId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)) {
    throw new Error("--grant-id=<UUID>가 올바르지 않습니다.");
  }
  if (source !== undefined) {
    if ((sourceId !== undefined) === (sinceText !== undefined || untilText !== undefined)) {
      throw new Error("source 조회에는 --source-id 또는 --since/--until 기간 중 하나가 필요합니다.");
    }
    if (sourceId !== undefined && !sourceId.trim()) {
      throw new Error("--source-id가 비어 있습니다.");
    }
    if (sourceId === undefined && (sinceText === undefined || untilText === undefined)) {
      throw new Error("기간 조회에는 --since와 --until이 모두 필요합니다.");
    }
  } else if (sourceId !== undefined || sinceText !== undefined || untilText !== undefined) {
    throw new Error("--source-id/--since/--until은 --source와 함께 지정해야 합니다.");
  }
  if (afterSourceId !== undefined && (sourceId !== undefined || sinceText === undefined || untilText === undefined
      || !afterSourceId.trim())) {
    throw new Error("--after-source-id는 기간 조회에서만 비어 있지 않은 값으로 지정해야 합니다.");
  }
  const runIdArgs = process.argv.filter((arg) => arg.startsWith("--run-id="));
  const runShaArgs = process.argv.filter((arg) => arg.startsWith("--run-sha256="));
  if (runIdArgs.length > 1 || runShaArgs.length > 1) {
    throw new Error("exact run 선택 인자를 중복 지정할 수 없습니다.");
  }
  if ((runIdArgs.length === 1) !== (runShaArgs.length === 1)) {
    throw new Error("exact run 선택에는 --run-id와 --run-sha256을 함께 지정해야 합니다.");
  }
  if (source !== undefined && runIdArgs.length > 0) {
    throw new Error("run 선택은 exact --grant-id 조회에서만 허용됩니다.");
  }
  const runSelection = runIdArgs.length === 1 ? {
    grantId: grantId!,
    runId: runIdArgs[0]!.slice("--run-id=".length),
    runSha256: runShaArgs[0]!.slice("--run-sha256=".length),
  } : undefined;
  const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { options: "-c default_transaction_read_only=on" },
  });
  try {
    const db = drizzle(client, { schema });
    const report = await db.transaction(async (tx) => {
      if (source !== undefined) {
        return discoverGrantSupplyWork({
          db: tx,
          source: source === "bizinfo" ? "bizinfo" : "kstartup",
          ...(sourceId !== undefined ? { sourceIds: [sourceId] } : {
            since: parseTimestamp(sinceText!, "--since"),
            until: parseTimestamp(untilText!, "--until"),
            ...(afterSourceId !== undefined ? { afterSourceId } : {}),
          }),
        });
      }
      const [grant] = await tx.select({
        id: schema.grants.id,
        source: schema.grants.source,
        sourceId: schema.grants.sourceId,
      }).from(schema.grants).where(eq(schema.grants.id, grantId!)).limit(1);
      if (!grant) throw new Error("공고를 찾지 못했습니다.");
      const snapshot = await loadCurrentGrantSupplySnapshot({ db: tx, grantId: grantId! });
      if (!snapshot) return {
        schema: "grant-supply-inactive-v1",
        grantId: grantId!,
        reason: "not_open_visible_in_current_kst_application_window",
      };
      const assets = snapshot.nextWork.action === "condition_analysis"
        || snapshot.nextWork.action === "condition_review"
        ? await loadStoredGrantSupplyAssets({
          grantId: grantId!,
          source: grant.source,
          sourceId: grant.sourceId,
          sourceRevisionSha256: snapshot.readinessInput.source.revisionSha256 ?? "",
        })
        : { status: "checked" as const, assets: [] };
      return planGrantSupply({
        snapshot, inventory: assets,
        ...(runSelection ? { runSelection } : {}),
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function argument(prefix: string): string | undefined {
  const values = process.argv.filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`${prefix} 인자를 중복 지정할 수 없습니다.`);
  return values[0]?.slice(prefix.length);
}

function parseTimestamp(value: string, label: string): Date {
  if (!/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value)) {
    throw new Error(`${label}은 timezone이 포함된 ISO 시각이어야 합니다.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} 시각이 올바르지 않습니다.`);
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

/**
 * grants.agency_primary 백필: 각 grant 의 source·agency_jurisdiction·agency_operator 를
 * resolveGrantAgencyPrimary 로 정규화해 파생 컬럼(agency_primary)에 반영한다.
 *
 * 사용:
 *   dry-run(기본, DB 미변경): pnpm backfill:agency-primary -- --dry-run
 *   실제 반영:                pnpm backfill:agency-primary
 *
 * 원칙:
 *   - id 커서 배치(500건)로 전체 grants 를 순회한다.
 *   - 정규화 결과가 기존 agency_primary 와 같으면 스킵(불필요한 write 회피).
 *   - --dry-run 은 정규화 통계와 예정 업데이트 건수만 출력하고 DB 를 건드리지 않는다.
 */
import { asc, eq, gt } from "drizzle-orm";
import { resolveGrantAgencyPrimary } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const BATCH_SIZE = 500;
const dryRun = process.argv.includes("--dry-run");

loadMonorepoEnv();

async function main(): Promise<void> {
  const mode = dryRun ? "DRY-RUN" : "WRITE";
  console.log(`grants.agency_primary 백필 (${mode})\n`);

  const db = getCunoteDb();
  let cursor: string | null = null;
  let scanned = 0;
  let toUpdate = 0;
  let updated = 0;
  let resolvedNull = 0;

  for (;;) {
    const rows = await db
      .select({
        id: schema.grants.id,
        source: schema.grants.source,
        agencyJurisdiction: schema.grants.agencyJurisdiction,
        agencyOperator: schema.grants.agencyOperator,
        agencyPrimary: schema.grants.agencyPrimary,
      })
      .from(schema.grants)
      .where(cursor ? gt(schema.grants.id, cursor) : undefined)
      .orderBy(asc(schema.grants.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const agencyPrimary = resolveGrantAgencyPrimary({
        source: row.source,
        jurisdiction: row.agencyJurisdiction,
        operator: row.agencyOperator,
      });
      if (agencyPrimary === null) resolvedNull += 1;
      if (agencyPrimary === (row.agencyPrimary ?? null)) continue;
      toUpdate += 1;
      if (!dryRun) {
        await db
          .update(schema.grants)
          .set({ agencyPrimary })
          .where(eq(schema.grants.id, row.id));
        updated += 1;
      }
    }

    cursor = rows[rows.length - 1]!.id;
    console.log(`  진행: ${scanned}건 스캔, ${toUpdate}건 변경 예정 (커서=${cursor})`);
  }

  console.log(`\n요약: 스캔 ${scanned}건, 변경 예정 ${toUpdate}건, 반영 ${updated}건 (정규화 결과 null: ${resolvedNull}건).`);

  if (dryRun) {
    console.log("\n(dry-run — DB 미변경. 반영하려면 --dry-run 없이 실행)");
  }
}

main()
  .then(async () => {
    await closeCunoteDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeCunoteDb();
    process.exit(1);
  });

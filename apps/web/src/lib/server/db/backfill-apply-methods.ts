/**
 * grants.f_apply_methods 백필: 각 grant 의 apply_method(jsonb) 를 classifyApplyMethods 로
 * 접수방법 채널 배열로 분류해 정규화 컬럼(f_apply_methods)에 반영한다.
 *
 * 사용:
 *   dry-run(기본, DB 미변경): pnpm backfill:apply-methods -- --dry-run
 *   실제 반영:                pnpm backfill:apply-methods
 *
 * 원칙:
 *   - id 커서 배치(500건)로 전체 grants 를 순회한다.
 *   - 분류 결과가 기존 f_apply_methods 와 같으면 스킵(불필요한 write 회피).
 *   - --dry-run 은 채널 분포와 예정 업데이트 건수만 출력하고 DB 를 건드리지 않는다.
 */
import { asc, eq, gt } from "drizzle-orm";
import type { ApplyMethodChannel } from "@cunote/contracts";
import { classifyApplyMethods } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const BATCH_SIZE = 500;
const dryRun = process.argv.includes("--dry-run");

loadMonorepoEnv();

function sameChannels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

async function main(): Promise<void> {
  const mode = dryRun ? "DRY-RUN" : "WRITE";
  console.log(`grants.f_apply_methods 백필 (${mode})\n`);

  const db = getCunoteDb();
  const distribution = new Map<ApplyMethodChannel, number>();
  let cursor: string | null = null;
  let scanned = 0;
  let toUpdate = 0;
  let updated = 0;
  let emptyResult = 0;

  for (;;) {
    const rows = await db
      .select({
        id: schema.grants.id,
        applyMethod: schema.grants.applyMethod,
        fApplyMethods: schema.grants.fApplyMethods,
      })
      .from(schema.grants)
      .where(cursor ? gt(schema.grants.id, cursor) : undefined)
      .orderBy(asc(schema.grants.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const channels = classifyApplyMethods(row.applyMethod);
      if (channels.length === 0) emptyResult += 1;
      for (const channel of channels) {
        distribution.set(channel, (distribution.get(channel) ?? 0) + 1);
      }
      if (sameChannels(channels, row.fApplyMethods)) continue;
      toUpdate += 1;
      if (!dryRun) {
        await db
          .update(schema.grants)
          .set({ fApplyMethods: channels })
          .where(eq(schema.grants.id, row.id));
        updated += 1;
      }
    }

    cursor = rows[rows.length - 1]!.id;
    console.log(`  진행: ${scanned}건 스캔, ${toUpdate}건 변경 예정 (커서=${cursor})`);
  }

  console.log("\n채널 분포:");
  for (const channel of ["online", "email", "fax", "visit", "postal", "other"] as const) {
    console.log(`  ${channel.padEnd(7)} ${distribution.get(channel) ?? 0}건`);
  }
  console.log(`  (채널 없음: ${emptyResult}건)`);
  console.log(`\n요약: 스캔 ${scanned}건, 변경 예정 ${toUpdate}건, 반영 ${updated}건.`);

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

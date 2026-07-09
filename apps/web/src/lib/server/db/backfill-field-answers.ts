/**
 * grant_document_drafts.field_answers 백필 (Apply Experience v2 · ADR-5 / P2-1).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md ADR-5 "백필·쓰기 정합", §6.2.
 *
 * 기존 filledFields 각 (label,value) 를 `{status:"accepted", source:"template"}` 로 1회 백필한다.
 * (기존 값은 이미 export 에 쓰이던 값이므로 accepted 가 정직한 이관.) 멱등 — 이미 field_answers 가
 * 있는 행은 건드리지 않는다.
 *
 * 사용:
 *   dry-run(기본, DB 미변경):   pnpm backfill:field-answers
 *   실제 반영(--write 옵트인):    pnpm backfill:field-answers -- --write
 *
 * 주의: --write 는 마이그레이션(field_answers 컬럼 추가) 적용 후에만 동작한다.
 *       dry-run 은 컬럼 없이도 동작하도록 field_answers 를 SELECT 하지 않는다.
 */
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { materializeFieldAnswers } from "../documents/fieldAnswers";

const BATCH_SIZE = 500;
const write = process.argv.includes("--write");

loadMonorepoEnv();

async function main(): Promise<void> {
  const mode = write ? "WRITE" : "DRY-RUN";
  console.log(`grant_document_drafts.field_answers 백필 (${mode})\n`);

  const db = getCunoteDb();
  let cursor: string | null = null;
  let scanned = 0;
  let candidates = 0;
  let updated = 0;
  let samplesPrinted = 0;

  for (;;) {
    // dry-run 은 field_answers 컬럼을 참조하지 않는다(마이그레이션 미적용 상태 대응).
    // write 는 field_answers IS NULL 로 멱등 필터한다.
    const rows = await db
      .select({
        id: schema.grantDocumentDrafts.id,
        filledFields: schema.grantDocumentDrafts.filledFields,
      })
      .from(schema.grantDocumentDrafts)
      .where(
        write
          ? and(
              isNull(schema.grantDocumentDrafts.fieldAnswers),
              cursor ? gt(schema.grantDocumentDrafts.id, cursor) : undefined,
            )
          : cursor
            ? gt(schema.grantDocumentDrafts.id, cursor)
            : undefined,
      )
      .orderBy(asc(schema.grantDocumentDrafts.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const materialized = materializeFieldAnswers(row.filledFields);
      const labelCount = Object.keys(materialized).length;
      if (labelCount === 0) continue; // filledFields 가 비면 백필할 값이 없다
      candidates += 1;

      if (samplesPrinted < 3) {
        samplesPrinted += 1;
        const sample = Object.entries(materialized)
          .slice(0, 3)
          .map(([label, answer]) =>
            `${label}=${truncate(answer.value)}(${answer.status}/${answer.source})`,
          )
          .join(", ");
        console.log(`  샘플[${samplesPrinted}] draft=${row.id.slice(0, 8)} · ${labelCount}개 · ${sample}`);
      }

      if (write) {
        await db
          .update(schema.grantDocumentDrafts)
          .set({ fieldAnswers: materialized })
          .where(and(
            eq(schema.grantDocumentDrafts.id, row.id),
            isNull(schema.grantDocumentDrafts.fieldAnswers),
          ));
        updated += 1;
      }
    }

    cursor = rows[rows.length - 1]!.id;
    console.log(`  진행: ${scanned}건 스캔, ${candidates}건 백필 대상 (커서=${cursor})`);
  }

  console.log(`\n요약: 스캔 ${scanned}건, 백필 대상 ${candidates}건, 반영 ${updated}건.`);
  if (!write) {
    console.log("\n(dry-run — DB 미변경. 반영하려면 마이그레이션 적용 후 `-- --write` 로 실행)");
  }
}

function truncate(value: string, max = 20): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
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

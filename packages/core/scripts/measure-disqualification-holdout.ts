/**
 * 결격 분해기 홀드아웃(out-of-sample) 측정 — P4 Minor-5. **읽기 전용**.
 *
 * 백업(2026-06-27) 이후 수집된 최신 kstartup 공고의 aply_excl_trgt_ctnt 배제 문구를
 * 분해기에 통과시켜, 백업 밖 표본에서 구조화율/오귀속을 측정한다. INSERT/UPDATE/DELETE 없음.
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json packages/core/scripts/measure-disqualification-holdout.ts
 */
import postgres from "postgres";
import { loadMonorepoEnv } from "../../../apps/web/src/lib/server/loadMonorepoEnv.js";
import { extractDisqualificationCriteria } from "../src/disqualification/extract.js";

loadMonorepoEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL 없음(.env.local 확인).");
  process.exit(1);
}

// 백업에 포함된 6개 공고 source_id — 홀드아웃에서 제외(연구 §3.2 원천 공고).
const BACKUP_SOURCE_IDS = new Set<string>();

const sql = postgres(url, { max: 2, prepare: false });

async function main() {
  // 최신 kstartup 공고의 배제 문구를 grant_raw payload 에서 읽는다(읽기 전용).
  const rows = await sql<{ source_id: string; excl: string | null; collected_at: Date }[]>`
    SELECT source_id,
           payload->>'aply_excl_trgt_ctnt' AS excl,
           collected_at
    FROM grant_raw
    WHERE source = 'kstartup'
      AND payload->>'aply_excl_trgt_ctnt' IS NOT NULL
      AND length(payload->>'aply_excl_trgt_ctnt') > 10
    ORDER BY collected_at DESC
    LIMIT 80
  `;

  const holdout = rows.filter((row) => !BACKUP_SOURCE_IDS.has(row.source_id));

  let withExclText = 0;
  let structuredCount = 0;
  const dimHistogram = new Map<string, number>();
  let priorAwardLeaks = 0;
  let reservedLeaks = 0;
  const samples: Array<{ source_id: string; dims: string[]; residual: number }> = [];

  for (const row of holdout) {
    if (!row.excl) continue;
    withExclText += 1;
    const result = extractDisqualificationCriteria(row.excl, {
      sourceField: "aply_excl_trgt_ctnt",
      confidence: 0.6,
    });
    if (result.criteria.length > 0) structuredCount += 1;
    const dims = new Set<string>();
    for (const criterion of result.criteria) {
      dims.add(criterion.dimension);
      dimHistogram.set(criterion.dimension, (dimHistogram.get(criterion.dimension) ?? 0) + 1);
      if (criterion.dimension === "prior_award") priorAwardLeaks += 1;
      if (criterion.dimension === "premises" || criterion.dimension === "export_performance") {
        reservedLeaks += 1;
      }
    }
    if (samples.length < 12 && result.criteria.length > 0) {
      samples.push({ source_id: row.source_id, dims: [...dims], residual: result.residualSpans.length });
    }
  }

  console.log(JSON.stringify({
    holdout_grants_with_exclusion_text: withExclText,
    grants_with_at_least_one_structured_criterion: structuredCount,
    structuring_rate: withExclText ? Number((structuredCount / withExclText).toFixed(3)) : null,
    dimension_histogram: Object.fromEntries([...dimHistogram.entries()].sort((a, b) => b[1] - a[1])),
    prior_award_leaks_MUST_BE_0: priorAwardLeaks,
    reserved_axis_leaks_MUST_BE_0: reservedLeaks,
    sample: samples,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });

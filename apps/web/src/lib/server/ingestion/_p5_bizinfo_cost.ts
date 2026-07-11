import { sql } from "drizzle-orm";
import { buildBizInfoProgramExtractionInput, type BizInfoProgram } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import * as schema from "../db/schema";
import { inArray } from "drizzle-orm";

loadMonorepoEnv();
const db = getCunoteDb();
try {
  // bizinfo raw count (re-extraction target = all bizinfo grants)
  const total = await db.execute(sql`select count(*)::int as n from grant_raw where source='bizinfo'`);
  console.log("BIZINFO_RAW_TOTAL:", JSON.stringify(total[0]));

  // sample N raw payloads, build extraction input, measure char length -> token estimate
  const rows = await db
    .select({ payload: schema.grantRaw.payload })
    .from(schema.grantRaw)
    .where(inArray(schema.grantRaw.source, ["bizinfo"]))
    .limit(200);
  let sumChars = 0, n = 0, maxChars = 0, minChars = Number.MAX_SAFE_INTEGER;
  for (const r of rows) {
    try {
      const doc = buildBizInfoProgramExtractionInput(r.payload as unknown as BizInfoProgram);
      // The extractor sends first 12000 chars of doc.text (per findings). Measure realistic sent size.
      const sent = (doc.text ?? "").slice(0, 12000);
      const len = sent.length;
      sumChars += len; n += 1;
      if (len > maxChars) maxChars = len;
      if (len < minChars) minChars = len;
    } catch { /* skip */ }
  }
  const avgChars = n ? Math.round(sumChars / n) : 0;
  console.log("SAMPLE_N:", n, "AVG_SENT_CHARS:", avgChars, "MIN:", minChars, "MAX:", maxChars);
  // Korean text ~ 1 token per ~2-2.5 chars for Claude tokenizer; use conservative 2.2 chars/token for KO body.
  // System prompt ~590 tokens (2358 chars). Add doc chars.
  const sysTokens = 590;
  const docTokens = Math.round(avgChars / 2.2);
  console.log("EST_INPUT_TOKENS_PER_GRANT:", sysTokens + docTokens, "(sys", sysTokens, "+ doc", docTokens, ")");
} finally {
  await closeCunoteDb();
}

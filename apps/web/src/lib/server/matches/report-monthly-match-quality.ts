import { and, eq, gte, lt } from "drizzle-orm";
import { buildMatchFeedbackQualityReport } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();
const { start, end, month } = monthRange(readArg("month"));
const db = getCunoteDb();
try {
  const rows = await db.select({
    id: schema.feedback.id,
    actor: schema.feedback.actor,
    timestamp: schema.feedback.ts,
    value: schema.feedback.value,
  }).from(schema.feedback).where(and(
    eq(schema.feedback.targetType, "match"),
    gte(schema.feedback.ts, start),
    lt(schema.feedback.ts, end),
  ));
  const report = buildMatchFeedbackQualityReport({
    records: rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      timestamp: row.timestamp.toISOString(),
      value: row.value,
    })),
    periodStart: start,
    periodEnd: end,
  });
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    month,
    writeMode: false,
    ...report,
    nextGate: report.operationalReady
      ? "review backlog 처리 후 승인된 correction만 다음 evaluation fixture 후보로 승격"
      : "provenance coverage 95% 및 reviewer record 유효성 확보",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function monthRange(value: string | undefined): { month: string; start: Date; end: Date } {
  const month = value ?? new Date().toISOString().slice(0, 7);
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("--month must use YYYY-MM");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error("--month must use YYYY-MM");
  return {
    month,
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

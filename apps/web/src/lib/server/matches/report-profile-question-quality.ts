import { and, eq, gte, lt } from "drizzle-orm";
import { buildProfileQuestionQualityReport } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();
const { start, end, month } = monthRange(readArg("month"));
const ruleset = readArg("ruleset");
const db = getCunoteDb();
try {
  const rows = await db.select({
    id: schema.profileQuestionEvents.id,
    sessionId: schema.profileQuestionEvents.sessionId,
    timestamp: schema.profileQuestionEvents.ts,
    rulesetVer: schema.profileQuestionEvents.rulesetVer,
    dimension: schema.profileQuestionEvents.dimension,
    targetedConditionalCount: schema.profileQuestionEvents.targetedConditionalCount,
    dimensionResolvedGrantCount: schema.profileQuestionEvents.dimensionResolvedGrantCount,
    eligibilityResolvedCount: schema.profileQuestionEvents.eligibilityResolvedCount,
  }).from(schema.profileQuestionEvents).where(and(
    gte(schema.profileQuestionEvents.ts, start),
    lt(schema.profileQuestionEvents.ts, end),
    ...(ruleset ? [eq(schema.profileQuestionEvents.rulesetVer, ruleset)] : []),
  ));
  const report = buildProfileQuestionQualityReport({
    records: rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      timestamp: row.timestamp.toISOString(),
      rulesetVer: row.rulesetVer,
      dimension: row.dimension,
      targetedConditionalCount: row.targetedConditionalCount,
      dimensionResolvedGrantCount: row.dimensionResolvedGrantCount,
      eligibilityResolvedCount: row.eligibilityResolvedCount,
    })),
    periodStart: start,
    periodEnd: end,
  });
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    month,
    ruleset: ruleset ?? null,
    writeMode: false,
    rawAnswerStored: false,
    ...report,
    gates: {
      minimumEvents: 30,
      minimumSessions: 10,
      conditionalResolutionRate: 0.6,
      questionsToFirstResolutionP50: 3,
    },
    nextGate: report.operationalReady
      ? "사람 검수 holdout에서 질문 전후 판정 정확도를 확인"
      : "질문 이벤트 표본과 conditional 해소율·첫 해소 질문 수 gate 확보",
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

/** 운영 prior_award 38행의 형식 호환 회귀 snapshot 생성. DB read-only, 파일 출력만 선택 수행. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { adaptPriorAwardCriterionValue } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();
const output = resolve(readArg("output") ?? "packages/core/golden/matching/prior-award-legacy-regression-v1.json");
const writeOutput = process.argv.includes("--write-output");
const db = getCunoteDb();
try {
  const rows = await db.select({
    criterionId: schema.grantCriteria.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    status: schema.grants.status,
    kind: schema.grantCriteria.kind,
    operator: schema.grantCriteria.operator,
    value: schema.grantCriteria.value,
    parserVersion: schema.grantCriteria.parserVersion,
  }).from(schema.grantCriteria)
    .innerJoin(schema.grants, eq(schema.grantCriteria.grantId, schema.grants.id))
    .where(eq(schema.grantCriteria.dimension, "prior_award"))
    .orderBy(asc(schema.grants.source), asc(schema.grants.sourceId), asc(schema.grantCriteria.id));
  const snapshot = {
    goldenVer: "prior-award-legacy-regression-v1",
    snapshotStatus: "legacy_format_regression_not_eligibility_truth",
    capturedAt: "2026-07-12T00:00:00.000Z",
    expectedCaseCount: rows.length,
    expectedValueKeyCounts: valueKeyCounts(rows.map((row) => row.value)),
    cases: rows.map((row) => ({
      criterionId: row.criterionId,
      source: row.source,
      sourceId: row.sourceId,
      status: row.status,
      kind: row.kind,
      operator: row.operator,
      value: row.value,
      parserVersion: row.parserVersion,
      expectedAdapted: adaptPriorAwardCriterionValue(row.value),
    })),
  };
  if (writeOutput) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({
    ok: true,
    databaseWrite: false,
    outputWrite: writeOutput,
    output: writeOutput ? output : null,
    caseCount: rows.length,
    byParserVersion: histogram(rows.map((row) => row.parserVersion ?? "null")),
    byKindOperator: histogram(rows.map((row) => `${row.kind}/${row.operator}`)),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function valueKeyCounts(values: Array<Record<string, unknown>>): Record<string, number> {
  return histogram(values.flatMap((value) => Object.keys(value)));
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

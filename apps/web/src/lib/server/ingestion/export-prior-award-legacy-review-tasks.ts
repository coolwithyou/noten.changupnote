/** 활성 BizInfo legacy prior_award exclusion 4건의 독립 검수 산출물 생성. DB read-only. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { GrantCriterion } from "@cunote/contracts";
import {
  buildMatchingV3GrantReviewTask,
  extractPriorAwardCriteria,
  renderMatchingV3ReviewWorkbench,
  type BizInfoProgram,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const outputPath = resolve(readArg("output") ?? "tmp/prior-award-legacy-review-tasks.jsonl");
const annotationsPath = resolve(readArg("annotations-output") ?? "tmp/prior-award-legacy-draft-annotations.jsonl");
const workbenchPath = resolve(readArg("workbench-output") ?? "tmp/prior-award-legacy-review-workbench.html");
const force = process.argv.includes("--force");
if (!force && [outputPath, annotationsPath, workbenchPath].some(existsSync)) {
  throw new Error("output exists; use --force to replace legacy prior_award review artifacts");
}

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<BizInfoProgram>({ dialect: "drizzle", client: db });
  const rows = await db.select({
    criterionId: schema.grantCriteria.id,
    grantRowId: schema.grantCriteria.grantId,
    sourceId: schema.grants.sourceId,
    operator: schema.grantCriteria.operator,
    value: schema.grantCriteria.value,
    confidence: schema.grantCriteria.confidence,
    sourceSpan: schema.grantCriteria.sourceSpan,
    sourceField: schema.grantCriteria.sourceField,
    parserVersion: schema.grantCriteria.parserVersion,
  }).from(schema.grantCriteria)
    .innerJoin(schema.grants, eq(schema.grantCriteria.grantId, schema.grants.id))
    .where(and(
      eq(schema.grants.source, "bizinfo"),
      eq(schema.grantCriteria.dimension, "prior_award"),
      eq(schema.grantCriteria.kind, "exclusion"),
      inArray(schema.grants.status, ["open", "upcoming"]),
    ));

  const tasks = [];
  let proposedV2Count = 0;
  for (const row of rows) {
    const entry = await repositories.grants.findGrantById(`bizinfo:${row.sourceId}`);
    if (!entry) throw new Error(`current grant not found: bizinfo:${row.sourceId}`);
    const sourceText = row.sourceSpan ?? note(row.value);
    const proposed = extractPriorAwardCriteria(sourceText, {
      enabled: true,
      sourceField: row.sourceField ?? "legacy_prior_award",
      confidence: 0.6,
    }).criteria.map((criterion, index): GrantCriterion => ({
      ...criterion,
      id: `bizinfo:${row.sourceId}:prior-award-remediation-${index + 1}`,
      grant_id: row.sourceId,
      parser_version: "prior-award-legacy-remediation-draft-v1",
    }));
    proposedV2Count += proposed.length;
    const legacy: GrantCriterion = {
      id: row.criterionId,
      grant_id: row.sourceId,
      dimension: "prior_award",
      operator: row.operator,
      kind: "exclusion",
      value: row.value,
      confidence: row.confidence,
      ...(row.sourceSpan ? { source_span: row.sourceSpan } : {}),
      ...(row.sourceField ? { source_field: row.sourceField } : {}),
      needs_review: true,
      ...(row.parserVersion ? { parser_version: row.parserVersion } : {}),
    };
    const inputSha256 = createHash("sha256")
      .update(JSON.stringify({ sourceId: row.sourceId, criterionId: row.criterionId, sourceText, value: row.value }))
      .digest("hex");
    tasks.push(buildMatchingV3GrantReviewTask(entry, {
      sourceFixture: `prior-award-legacy:bizinfo:${row.sourceId}:${inputSha256}`,
      predictedCriteria: proposed.length > 0 ? proposed : [legacy],
      predictionProvenance: {
        extractorVersion: "prior-award-legacy-remediation-draft-v1",
        model: proposed.length > 0 ? "deterministic" : "legacy-needs-human-rewrite",
        inputSha256,
      },
    }));
  }

  const workbench = renderMatchingV3ReviewWorkbench({ companyTasks: [], grantTasks: tasks, pairTasks: [], includeHoldout: false });
  for (const forbidden of ["archive_url", "storage_key", "source_uri", "markdown_storage_key"]) {
    if (workbench.includes(`\"${forbidden}\"`)) throw new Error(`forbidden storage field in workbench: ${forbidden}`);
  }
  for (const path of [outputPath, annotationsPath, workbenchPath]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(outputPath, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
  writeFileSync(annotationsPath, `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
  writeFileSync(workbenchPath, workbench, "utf8");
  console.log(JSON.stringify({
    ok: true,
    databaseWrite: false,
    externalApiCall: false,
    taskCount: tasks.length,
    proposedV2Count,
    targetedHumanRewriteCount: tasks.length - proposedV2Count,
    outputPath,
    annotationsPath,
    workbenchPath,
    operationalReady: false,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function note(value: Record<string, unknown>): string {
  return typeof value.note === "string" ? value.note : "";
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

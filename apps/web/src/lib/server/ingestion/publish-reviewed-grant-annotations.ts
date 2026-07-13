import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { GrantCriterion } from "@cunote/contracts";
import {
  mergeGrantIndustryTags,
  parseV3AnnotationJsonl,
  planReviewedGrantPublication,
  projectGrantIndustryTags,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const input = readArg("input");
if (!input) throw new Error("--input=<reviewed-annotations.jsonl> is required");
const inputPath = resolve(input);
const write = process.argv.includes("--write");
if (write && readArg("confirm") !== "PUBLISH_REVIEWED_GRANT_ANNOTATIONS") {
  throw new Error("--write requires --confirm=PUBLISH_REVIEWED_GRANT_ANNOTATIONS");
}
const dataset = parseV3AnnotationJsonl(readFileSync(inputPath, "utf8"), inputPath);
const unreviewed = dataset.grants.filter((annotation) => annotation.labelStatus !== "reviewed");
const reviewed = dataset.grants.filter((annotation) => annotation.labelStatus === "reviewed");
if (reviewed.length === 0) throw new Error("no reviewed grant annotations found");

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const plans = [];
  for (const annotation of reviewed) {
    const current = await repositories.grants.findGrantById(`${annotation.source}:${annotation.sourceId}`);
    if (!current) throw new Error(`current grant not found: ${annotation.source}:${annotation.sourceId}`);
    plans.push({ annotation, plan: planReviewedGrantPublication(annotation, current), current });
  }

  if (!write) {
    console.log(JSON.stringify({
      mode: "dry-run",
      inputPath,
      annotationCount: dataset.grants.length,
      reviewedCount: reviewed.length,
      unreviewedCount: unreviewed.length,
      unreviewedAction: "skipped",
      publishableCount: plans.length,
      criteriaCount: plans.reduce((sum, item) => sum + item.plan.criteria.length, 0),
      staleMatchStateAction: "delete by grant; rebuilt by match-state refresh",
      plans: plans.map((item) => ({
        grantId: item.plan.grantId,
        source: item.plan.source,
        sourceId: item.plan.sourceId,
        reviewerId: item.plan.reviewerId,
        reviewedAt: item.plan.reviewedAt,
        sourceRevision: item.plan.sourceRevision,
        criteriaCount: item.plan.criteria.length,
      })),
    }, null, 2));
  } else {
    const results = [];
    for (const item of plans) {
      const grantRowId = item.current.grant.id;
      if (!grantRowId) throw new Error(`current grant row id missing: ${item.plan.grantId}`);
      const result = await db.transaction(async (tx) => {
        await tx.delete(schema.grantCriteria).where(eq(schema.grantCriteria.grantId, grantRowId));
        if (item.plan.criteria.length > 0) {
          await tx.insert(schema.grantCriteria).values(item.plan.criteria.map((criterion) =>
            criterionInsertValues(grantRowId, criterion)));
        }
        const fIndustries = mergeGrantIndustryTags(
          item.current.grant.f_industries,
          projectGrantIndustryTags(item.plan.criteria),
        );
        await tx.update(schema.grants).set({
          fIndustries,
          parserVersion: item.plan.parserVersion,
          overallConfidence: average(item.plan.criteria.map((criterion) => criterion.confidence)),
          updatedAt: new Date(),
        }).where(eq(schema.grants.id, grantRowId));
        const deletedStates = await tx
          .delete(schema.matchState)
          .where(eq(schema.matchState.grantId, grantRowId))
          .returning({ companyId: schema.matchState.companyId });
        await tx.insert(schema.extractionLog).values({
          grantId: grantRowId,
          inputRef: item.annotation.sourceFixture,
          output: {
            schemaVersion: "matching-v3",
            labelStatus: "reviewed",
            reviewerId: item.plan.reviewerId,
            reviewedAt: item.plan.reviewedAt,
            sourceRevision: item.plan.sourceRevision,
            parserVersion: item.plan.parserVersion,
            criterionIds: item.plan.criteria.map((criterion) => criterion.id),
          },
          confidence: average(item.plan.criteria.map((criterion) => criterion.confidence)),
          status: "labeled",
          modelVer: item.plan.parserVersion,
          promptVer: "matching-v3",
        });
        return { deletedMatchStateCount: deletedStates.length };
      });
      const refreshed = await repositories.grants.findGrantById(`${item.plan.source}:${item.plan.sourceId}`);
      if (!refreshed?.extraction_manifest?.reviewedAt) {
        throw new Error(`reviewed extraction manifest hydration failed: ${item.plan.grantId}`);
      }
      results.push({
        grantId: item.plan.grantId,
        criteriaCount: item.plan.criteria.length,
        reviewedAt: refreshed.extraction_manifest.reviewedAt,
        readiness: refreshed.extraction_manifest.readiness,
        deletedMatchStateCount: result.deletedMatchStateCount,
      });
    }
    console.log(JSON.stringify({
      mode: "write",
      publishedCount: results.length,
      matchStateRefreshRequired: true,
      results,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function criterionInsertValues(grantId: string, criterion: GrantCriterion): typeof schema.grantCriteria.$inferInsert {
  return {
    grantId,
    dimension: criterion.dimension,
    operator: criterion.operator,
    value: criterion.value as Record<string, unknown>,
    kind: criterion.kind,
    weight: criterion.weight ?? null,
    confidence: criterion.confidence,
    sourceSpan: criterion.source_span ?? null,
    rawText: criterion.raw_text ?? null,
    sourceField: criterion.source_field ?? null,
    needsReview: false,
    parserVersion: criterion.parser_version ?? "reviewer:matching-v3",
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

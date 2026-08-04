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
import { acquireGrantPublicationLock } from "./grantPublicationLock";
import {
  hasPromotionProtectedCriteria,
  selectPromotionProtectedGrantIds,
  warnPromotionProtectedSkip,
} from "./normalizedGrantPublisher";
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

  // P1 승격 보호 가드 (docs/research/2026-08-04-운영-딥분석-크론과-로컬-구독-겹침-조사.md §3 P1):
  // stable_key 행이 있는 grant 는 승격 큐레이션 세트가 서빙 중 — reviewed 재발행(delete→insert)과
  // 그 파생 쓰기(fIndustries·reviewed extraction_log)로 말소·모순을 만들지 않는다.
  // 이 일괄 판별은 dry-run 안내·사전 스킵용이고, write 의 최종 결정(정본)은 grant별 트랜잭션
  // 안에서 발행 lock 획득 후 재판별한다(lab:promote --write 와의 TOCTOU 경쟁 창 해소).
  const promotionProtectedGrantIds = await selectPromotionProtectedGrantIds(
    db,
    plans
      .map((item) => item.current.grant.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  if (!write) {
    console.log(JSON.stringify({
      mode: "dry-run",
      inputPath,
      annotationCount: dataset.grants.length,
      reviewedCount: reviewed.length,
      unreviewedCount: unreviewed.length,
      unreviewedAction: "skipped",
      publishableCount: plans.length,
      promotionProtectedCount: promotionProtectedGrantIds.size,
      // write 실효과와 일치: 보호 스킵분 criteria 는 criteriaCount 에서 제외하고 별도 병기.
      criteriaCount: plans.reduce((sum, item) =>
        sum + (promotionProtectedGrantIds.has(item.current.grant.id ?? "") ? 0 : item.plan.criteria.length), 0),
      promotionProtectedSkippedCriteriaCount: plans.reduce((sum, item) =>
        sum + (promotionProtectedGrantIds.has(item.current.grant.id ?? "") ? item.plan.criteria.length : 0), 0),
      staleMatchStateAction: "delete by grant; rebuilt by match-state refresh",
      plans: plans.map((item) => ({
        grantId: item.plan.grantId,
        promotionProtected: promotionProtectedGrantIds.has(item.current.grant.id ?? ""),
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
    const promotionProtectedSkipped: string[] = [];
    for (const item of plans) {
      const grantRowId = item.current.grant.id;
      if (!grantRowId) throw new Error(`current grant row id missing: ${item.plan.grantId}`);
      if (promotionProtectedGrantIds.has(grantRowId)) {
        // criteria 교체만이 아니라 fIndustries·reviewed extraction_log 도 승격 세트와 모순을
        // 만들므로 이 grant 의 발행 전체를 스킵한다.
        warnPromotionProtectedSkip(`${item.plan.grantId} (grant ${grantRowId})`);
        promotionProtectedSkipped.push(item.plan.grantId);
        continue;
      }
      const result = await db.transaction(async (tx) => {
        // 정본 판별: 발행 lock 획득 후 보호 여부를 재판별한다 — 위 일괄 판별 이후
        // lab:promote --write 가 끼어든 경쟁 창(TOCTOU)을 닫는다.
        await acquireGrantPublicationLock(tx, grantRowId);
        const lockedCriteria = await tx
          .select({ stableKey: schema.grantCriteria.stableKey })
          .from(schema.grantCriteria)
          .where(eq(schema.grantCriteria.grantId, grantRowId));
        if (hasPromotionProtectedCriteria(lockedCriteria)) {
          return { promotionProtected: true as const };
        }
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
        return { promotionProtected: false as const, deletedMatchStateCount: deletedStates.length };
      });
      if (result.promotionProtected) {
        warnPromotionProtectedSkip(`${item.plan.grantId} (grant ${grantRowId})`);
        promotionProtectedSkipped.push(item.plan.grantId);
        continue;
      }
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
      promotionProtectedSkippedCount: promotionProtectedSkipped.length,
      promotionProtectedSkippedGrantIds: promotionProtectedSkipped,
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

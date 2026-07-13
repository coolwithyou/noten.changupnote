/**
 * 활성 legacy prior_award exclusion을 v2 치환 후보/재추출 대상으로 분류한다.
 * DB write, 외부 API, LLM 호출 없음.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { GrantCriterion } from "@cunote/contracts";
import { extractPriorAwardCriteria, validateGrantCriteriaContract } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const db = getCunoteDb();
try {
  const rows = await db.select({
    criterionId: schema.grantCriteria.id,
    grantRowId: schema.grantCriteria.grantId,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    title: schema.grants.title,
    status: schema.grants.status,
    operator: schema.grantCriteria.operator,
    value: schema.grantCriteria.value,
    sourceSpan: schema.grantCriteria.sourceSpan,
    sourceField: schema.grantCriteria.sourceField,
    parserVersion: schema.grantCriteria.parserVersion,
  }).from(schema.grantCriteria)
    .innerJoin(schema.grants, eq(schema.grantCriteria.grantId, schema.grants.id))
    .where(and(
      eq(schema.grantCriteria.dimension, "prior_award"),
      eq(schema.grantCriteria.kind, "exclusion"),
      inArray(schema.grants.status, ["open", "upcoming"]),
    ));

  const plans = rows.map((row) => {
    const sourceText = row.sourceSpan ?? note(row.value);
    const extraction = extractPriorAwardCriteria(sourceText, {
      enabled: true,
      sourceField: row.sourceField ?? "legacy_prior_award",
      confidence: 0.6,
    });
    const proposed = extraction.criteria.map((criterion, index): GrantCriterion => ({
      ...criterion,
      id: `${row.source}:${row.sourceId}:prior-award-remediation-${index + 1}`,
      grant_id: row.sourceId,
      parser_version: "prior-award-legacy-remediation-draft-v1",
    }));
    const contractIssues = validateGrantCriteriaContract(proposed);
    const deterministicCandidate = proposed.length > 0 && contractIssues.length === 0;
    return {
      source: row.source,
      sourceId: row.sourceId,
      title: row.title,
      current: {
        criterionId: row.criterionId,
        operator: row.operator,
        value: row.value,
        sourceSpan: row.sourceSpan,
        parserVersion: row.parserVersion,
      },
      remediationMode: deterministicCandidate
        ? "deterministic_replacement_candidate"
        : "targeted_reextract_required",
      proposedCriteria: proposed.map((criterion) => ({
        operator: criterion.operator,
        value: criterion.value,
        sourceSpan: criterion.source_span ?? null,
      })),
      residualSpans: extraction.residualSpans,
      contractIssues: contractIssues.map((issue) => ({ path: issue.path, message: issue.message })),
      independentHumanReviewRequired: true,
      writeReady: false,
    };
  });

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    activeLegacyExclusionCount: rows.length,
    deterministicReplacementCandidateCount: plans.filter((plan) =>
      plan.remediationMode === "deterministic_replacement_candidate").length,
    targetedReextractRequiredCount: plans.filter((plan) =>
      plan.remediationMode === "targeted_reextract_required").length,
    writeReadyCount: 0,
    plans,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function note(value: Record<string, unknown>): string {
  return typeof value.note === "string" ? value.note : "";
}

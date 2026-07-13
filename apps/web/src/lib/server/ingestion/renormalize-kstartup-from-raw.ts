// P5 백필 — K-Startup 전량 재정규화(from stored grant_raw). LLM 불필요·deterministic.
//
// 배경(Minor-6 / D7): 차원 확장(14→22)으로 kstartup normalize v2 가 신규 결격 축을 rule-based
// 분해기로 구조화한다. 하지만 archive-kstartup 는 live 재fetch 경로뿐이고 raw_hash 불변이면
// skipUnchanged 로 건너뛴다. 저장된 grant_raw.payload 는 재정규화의 완전한 입력이므로(순수 함수),
// 여기서 전량을 재정규화해 criteria 를 재발행한다 — 네트워크·LLM 없이.
//
// 강제 재발행: 이 스크립트는 hash 게이트 없이 대상 grant 를 빠짐없이 재발행한다(P5 강제 재발행의
// kstartup 측 구현). 교체 시맨틱은 grant별 criteria delete-insert(publisher 와 동일)로 보장.
//
// 부수효과 최소화(안전): grant 코어 필드 + criteria 만 갱신한다. grant_raw payload·attachments,
// 변환(conversion) 후크, source_cursor 는 건드리지 않는다 — 재정규화는 첨부·원문을 바꾸지 않으므로.
//
// 사용:
//   dry-run(기본):   npx tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/ingestion/renormalize-kstartup-from-raw.ts
//   실제 쓰기:        ... renormalize-kstartup-from-raw.ts --write
//   활성만:          ... --active-only            (open/upcoming/unknown + apply_end 미도래)
//   배치 크기:        --batch=500                 (default 500)
//   prior dry-run:    ... --active-only --prior-award-split
//   prior 실제 쓰기:  ... --write --prior-award-split --prior-award-annotations=<reviewed.jsonl>
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import type { Grant, GrantCriterion } from "@cunote/contracts";
import {
  normalizeKStartupAnnouncement,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import * as schema from "../db/schema";
import { assessPriorAwardIndependentReview, type PriorAwardReviewCandidate } from "./priorAwardReviewGate";

loadMonorepoEnv();

const write = hasFlag("write");
const activeOnly = hasFlag("active-only");
const priorAwardSplit = hasFlag("prior-award-split");
const priorAwardAnnotationsPath = readArg("prior-award-annotations");
if (write && priorAwardSplit && !priorAwardAnnotationsPath) {
  throw new Error("--write --prior-award-split requires --prior-award-annotations=<reviewed.jsonl>");
}
if (priorAwardAnnotationsPath && !existsSync(priorAwardAnnotationsPath)) {
  throw new Error(`prior_award annotations file not found: ${priorAwardAnnotationsPath}`);
}
const batchSize = boundedInt(readArg("batch"), 500, 1, 2000);
const limit = readArg("limit") ? boundedInt(readArg("limit"), 100, 1, 1_000_000) : undefined;

interface RawRow {
  id: string;
  sourceId: string;
  payload: KStartupAnnouncement;
}

async function main() {
  const db = getCunoteDb();
  const started = Date.now();
  const startedIso = new Date().toISOString();

  const summary = {
    dryRun: !write,
    activeOnly,
    priorAwardSplit,
    priorAwardAnnotationsPath: priorAwardAnnotationsPath ?? null,
    batchSize,
    limit: limit ?? null,
    startedAt: startedIso,
    targetCount: 0,
    renormalizedGrants: 0,
    criteriaBefore: 0,
    criteriaAfter: 0,
    newDisqCriteria: 0,
    priorAwardCriteria: 0,
    priorAwardReviewRequired: 0,
    priorAwardReviewAccepted: 0,
    priorAwardReviewReady: false,
    disqByDimension: {} as Record<string, number>,
    errors: [] as Array<{ sourceId: string; message: string }>,
  };

  try {
    // 대상 grant 목록(재정규화는 grant 단위). grant_raw 와 grants 를 조인해 payload + grant.id 확보.
    const activeCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = (await db.execute(sql`
      select g.id as id, g.source_id as "sourceId", r.payload as payload
      from grants g
      join grant_raw r on r.source = g.source and r.source_id = g.source_id
      where g.source = 'kstartup'
      ${activeOnly ? sql`and g.status in ('open','upcoming','unknown') and (g.apply_end is null or g.apply_end >= ${activeCutoffIso}::timestamptz)` : sql``}
      order by g.updated_at desc
      ${limit !== undefined ? sql`limit ${limit}` : sql``}
    `)) as unknown as RawRow[];

    summary.targetCount = rows.length;
    const asOf = new Date();
    if (priorAwardSplit) {
      const candidates = buildPriorAwardCandidates(rows, asOf);
      const assessment = assessPriorAwardIndependentReview(
        candidates,
        priorAwardAnnotationsPath ? readFileSync(priorAwardAnnotationsPath, "utf8") : null,
        priorAwardAnnotationsPath ?? undefined,
      );
      summary.priorAwardReviewRequired = candidates.length;
      summary.priorAwardReviewAccepted = assessment.acceptedCriterionCount;
      summary.priorAwardReviewReady = assessment.ready;
      if (write && !assessment.ready) {
        throw new Error(
          `prior_award independent review gate failed: accepted ${assessment.acceptedCriterionCount}/${candidates.length}`,
        );
      }
    }
    console.log(`[renormalize-kstartup] target=${rows.length} write=${write} activeOnly=${activeOnly} priorAwardSplit=${priorAwardSplit} batch=${batchSize}`);

    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      await processBatch(db, chunk, asOf, summary, { priorAwardSplit });
      const done = Math.min(i + batchSize, rows.length);
      console.log(`[renormalize-kstartup] progress ${done}/${rows.length} renorm=${summary.renormalizedGrants} newDisq=${summary.newDisqCriteria} err=${summary.errors.length}`);
    }

    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ ...summary, elapsedMs, finishedAt: new Date().toISOString() }, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

async function processBatch(
  db: ReturnType<typeof getCunoteDb>,
  chunk: RawRow[],
  asOf: Date,
  summary: {
    renormalizedGrants: number;
    criteriaBefore: number;
    criteriaAfter: number;
    newDisqCriteria: number;
    priorAwardCriteria: number;
    disqByDimension: Record<string, number>;
    errors: Array<{ sourceId: string; message: string }>;
  },
  options: { priorAwardSplit: boolean },
): Promise<void> {
  const disqDims = new Set([
    "tax_compliance", "credit_status", "sanction",
    "financial_health", "insured_workforce", "investment",
  ]);

  // 배치 내 기존 criteria 수(비교용)
  const grantIds = chunk.map((r) => r.id);
  if (grantIds.length === 0) return;
  const beforeCounts = (await db
    .select({ grantId: schema.grantCriteria.grantId })
    .from(schema.grantCriteria)
    .where(inArray(schema.grantCriteria.grantId, grantIds))) as Array<{ grantId: string }>;
  summary.criteriaBefore += beforeCounts.length;

  for (const row of chunk) {
    try {
      const normalized = normalizeKStartupAnnouncement(row.payload, {
        asOf,
        collectedAt: asOf,
        priorAwardSplit: options.priorAwardSplit,
      });
      const grant = normalized.grant;
      const criteria = normalized.criteria;

      // 신규 결격 criteria 집계
      for (const c of criteria) {
        if (c.dimension === "prior_award") summary.priorAwardCriteria += 1;
        if (disqDims.has(c.dimension)) {
          summary.newDisqCriteria += 1;
          summary.disqByDimension[c.dimension] = (summary.disqByDimension[c.dimension] ?? 0) + 1;
        }
      }
      summary.criteriaAfter += criteria.length;

      if (write) {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.grants)
            .set(grantUpdateValues(grant, asOf))
            .where(eq(schema.grants.id, row.id));
          await tx.delete(schema.grantCriteria).where(eq(schema.grantCriteria.grantId, row.id));
          if (criteria.length > 0) {
            await tx.insert(schema.grantCriteria).values(
              criteria.map((c) => criterionInsertValues(row.id, c)),
            );
          }
        });
      }
      summary.renormalizedGrants += 1;
    } catch (error) {
      summary.errors.push({
        sourceId: row.sourceId,
        message: error instanceof Error ? error.message : String(error),
      });
      // 무한 재시도 금지 — 오류는 집계만 하고 다음 grant 로 진행. 다량 오류 시 상위에서 중단 판단.
      if (summary.errors.length > 50) {
        throw new Error(`재정규화 오류 임계 초과(${summary.errors.length}). 중단합니다. 첫 오류: ${summary.errors[0]?.message}`);
      }
    }
  }
}

function buildPriorAwardCandidates(rows: RawRow[], asOf: Date): PriorAwardReviewCandidate[] {
  return rows.flatMap((row) => {
    const criteria = normalizeKStartupAnnouncement(row.payload, {
      asOf,
      collectedAt: asOf,
      priorAwardSplit: true,
    }).criteria.filter((criterion) => criterion.dimension === "prior_award");
    const inputSha256 = createHash("sha256")
      .update(JSON.stringify({ sourceId: row.sourceId, exclusion: row.payload.aply_excl_trgt_ctnt ?? null }))
      .digest("hex");
    return criteria.map((criterion) => ({
      grantId: `kstartup:${row.sourceId}`,
      sourceId: row.sourceId,
      sourceFixture: `prior-award-p5:kstartup:${row.sourceId}:${inputSha256}`,
      criterionId: criterion.id ?? `kstartup:${row.sourceId}:prior-award-unknown`,
      operator: criterion.operator,
      value: criterion.value,
      sourceSpan: criterion.source_span ?? null,
    }));
  });
}

// normalizedGrantPublisher.grantUpdateValues 와 동일 매핑(재정규화가 바꿀 수 있는 필드 전부).
function grantUpdateValues(
  grant: Grant,
  updatedAt: Date,
): Omit<typeof schema.grants.$inferInsert, "id" | "source" | "sourceId"> {
  return {
    title: grant.title,
    url: grant.url ?? null,
    agencyJurisdiction: grant.agency_jurisdiction ?? null,
    agencyOperator: grant.agency_operator ?? null,
    agencyPrimary: grant.agency_primary ?? null,
    categoryL1: grant.category_l1 ?? null,
    categoryL2: grant.category_l2 ?? null,
    applyStart: dateValue(grant.apply_start),
    applyEnd: dateValue(grant.apply_end),
    applyMethod: grant.apply_method ?? null,
    supportAmount: (grant.support_amount ?? null) as Record<string, unknown> | null,
    benefits: (grant.benefits ?? null) as Array<Record<string, unknown>> | null,
    requiredDocuments: (grant.required_documents ?? null) as Array<Record<string, unknown>> | null,
    status: grant.status,
    fRegions: grant.f_regions,
    fIndustries: grant.f_industries,
    fBizAgeMinMonths: grant.f_biz_age_min_months ?? null,
    fBizAgeMaxMonths: grant.f_biz_age_max_months ?? null,
    fSizes: grant.f_sizes,
    fFounderTraits: grant.f_founder_traits,
    fRequiredCerts: grant.f_required_certs,
    fApplyMethods: grant.f_apply_methods ?? [],
    fAuthoringMode: grant.f_authoring_mode ?? "unknown",
    overallConfidence: grant.overall_confidence,
    modelVer: grant.model_ver ?? null,
    promptVer: grant.prompt_ver ?? null,
    parserVersion: grant.parser_version ?? null,
    updatedAt,
  };
}

function criterionInsertValues(
  grantId: string,
  criterion: GrantCriterion,
): typeof schema.grantCriteria.$inferInsert {
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
    needsReview: criterion.needs_review ?? false,
    parserVersion: criterion.parser_version ?? null,
  };
}

function dateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

await main();

// 공모 딥분석 실험실 — 매칭 임팩트 섀도 측정 CLI (dev 전용, tsx 단독 실행).
// 검수 확정(correct) criteria 로 match_state 를 프로덕션 DB 반영 없이 **섀도 재계산**해,
// 사전 등록 지표 4종(확대 실험 계획 2026-07-21 §4)의 전(현행 DB criteria)/후(딥분석 검수
// 확정 criteria) 절대량을 잰다. 결과는 spike-out/analysis-lab/shadow/<stamp>/shadow-report.json
// 과 stdout 요약으로만 낸다.
// **원칙: DB 쓰기 0 · LLM 호출 0 · 외부 API 호출 0** — DB 는 select 만 수행한다.
//   - 회사 프로필: system_recompute 컨텍스트(저장 프로필, DB read) + --bizNo 는
//     anonymous_teaser 컨텍스트(팝빌 등 enrichment 캐시 cache_only, DB read) — 두 경로 모두
//     외부 fetch 없음(resolveProductCompanyProfile 의 refreshOwnedSource 는 owned_refresh 전용).
//   - 후 지표는 하한 추정: missed_condition(누락 조건)·needs_edit(수정 필요)는 구조화 값이
//     없어 섀도에 미반영, 건수만 caveat 병기(계획 §7).
// 실행: pnpm lab:shadow -- [--all] [--companyId=CSV] [--bizNo=CSV] [--asOf=ISO] [--verbose]
//   --all 은 cohort.json 밖 검수(파일럿 3건 등)까지 포함한다(스모크 용도).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompanyProfile, GrantCriterion, MatchResult, NormalizedGrant } from "@cunote/contracts";
import { isProfileResolvableCriterion, maskCorpNum, planProfileQuestions } from "@cunote/core";
import {
  AI_REVIEW_ADOPTED,
  type LabReview,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { buildGrantAnalysisShadowMatch } from "../ingestion/grantAnalysisPilotVariants";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { resolveSystemProductCompanyProfile } from "../productProfile/resolveProductCompanyProfile";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { selectReviewedRuns } from "./reviewed-runs";
import { analysisLabDir } from "./run-store";
import {
  convertReviewedLabRun,
  type ShadowConversionReport,
} from "./shadow-convert";

loadMonorepoEnv();

// ---- argv 파싱 (batch.ts 관행 — 라이브러리 없이) --------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function csvArg(value: string | undefined): string[] {
  return value ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))] : [];
}

interface ShadowOptions {
  scanAll: boolean;
  verbose: boolean;
  asOf: Date;
  bizNos: string[];
  companyIds: string[];
}

/** 옵션 검증 — 오류면 사유 문자열 반환(호출부에서 안내 후 exit 1). */
function parseOptions(): ShadowOptions | string {
  const asOfRaw = readArg("asOf");
  const asOf = asOfRaw ? new Date(asOfRaw) : new Date();
  if (Number.isNaN(asOf.getTime())) return "--asOf 는 유효한 ISO 시각이어야 합니다.";
  return {
    scanAll: hasFlag("all"),
    verbose: hasFlag("verbose"),
    asOf,
    bizNos: csvArg(readArg("bizNo")),
    companyIds: csvArg(readArg("companyId")),
  };
}

// ---- 매치 요약·지표 성분 --------------------------------------------------------

/** review_gate 부재 런타임 호환 — 07-15 파일럿 스크립트와 동일한 tier 폴백. */
function tierOf(match: MatchResult): string {
  return match.review_gate?.tier ?? (match.eligibility === "eligible"
    ? "recommendable"
    : match.eligibility === "ineligible"
      ? "not_recommended"
      : "needs_profile_input");
}

/** 공고×회사 1칸의 매치 요약 — 보고서 상세와 지표 집계가 같은 값을 공유한다. */
interface CompactShadowMatch {
  eligibility: MatchResult["eligibility"];
  tier: string;
  /** 지표 1: rule_trace 중 result ∈ {pass, fail} — 확정 판정 조건 수(절대량). */
  decided: number;
  pass: number;
  fail: number;
  /** hard(required/exclusion) unknown 수 — 지표 3 성분. */
  unknownHard: number;
  /** 지표 3: conditional + hard unknown 전부 profile-resolvable + dimension 1종. */
  singleQuestionResolvable: boolean;
  /** 지표 4 병기: fail 인 hard(required/exclusion) 조건의 dimension 목록. */
  failHardDimensions: string[];
}

function compactShadowMatch(match: MatchResult, criteria: readonly GrantCriterion[]): CompactShadowMatch {
  let pass = 0;
  let fail = 0;
  const failHardDimensions: string[] = [];
  // rule_trace 는 criteria 배열과 인덱스로 정렬된다(question-planner 의 확립된 관례).
  const hardUnknowns = match.rule_trace
    .map((trace, index) => ({ trace, criterion: criteria[index] }))
    .filter(({ trace }) => {
      if (trace.result === "pass") pass += 1;
      if (trace.result === "fail") {
        fail += 1;
        if (trace.kind === "required" || trace.kind === "exclusion") {
          failHardDimensions.push(trace.dimension);
        }
      }
      return trace.result === "unknown" && (trace.kind === "required" || trace.kind === "exclusion");
    });
  const singleQuestionResolvable =
    match.eligibility === "conditional" &&
    hardUnknowns.length > 0 &&
    hardUnknowns.every(({ criterion }) => criterion !== undefined && isProfileResolvableCriterion(criterion)) &&
    new Set(hardUnknowns.map(({ trace }) => trace.dimension)).size === 1;
  return {
    eligibility: match.eligibility,
    tier: tierOf(match),
    decided: pass + fail,
    pass,
    fail,
    unknownHard: hardUnknowns.length,
    singleQuestionResolvable,
    failHardDimensions: [...new Set(failHardDimensions)],
  };
}

/** buildGrantAnalysisShadowMatch 내부 proposal 과 동일한 대체 공고(질문 플래너 입력용). */
function proposedEntryFor(
  entry: NormalizedGrant<unknown>,
  criteria: readonly GrantCriterion[],
): NormalizedGrant<unknown> {
  const { extraction_manifest: _manifest, ...rest } = entry;
  return { ...rest, criteria: criteria.map((criterion) => ({ ...criterion })) };
}

interface TopQuestionSummary {
  dimension: string;
  affectedGrantCount: number;
  resolvesGrantCount: number;
  prompt: string;
}

interface CompanyVariantMetrics {
  /** 지표 1 — 확정 판정 조건 수: 공고 합계·공고당 평균. */
  decidedTotal: number;
  decidedMeanPerGrant: number;
  /** 지표 3 — 질문 1개로 확정 가능 공고 수 + 플래너 상위 질문. */
  singleQuestionResolvableGrants: number;
  topQuestions: TopQuestionSummary[];
}

interface CompanyMetrics {
  companyKey: string;
  companyLabel: string;
  grantCount: number;
  before: CompanyVariantMetrics;
  after: CompanyVariantMetrics;
  /** 지표 2 — 전→후 전이 행렬("전→후" 키)과 상승/역방향 수. */
  tierMatrix: Record<string, number>;
  eligibilityMatrix: Record<string, number>;
  tierUpToRecommendable: number;
  tierDownFromRecommendable: number;
  eligibilityUpToEligible: number;
  eligibilityDownFromEligible: number;
  /** 지표 4 — 전 eligibility≠ineligible → 후 ineligible 공고와 후 hard fail 축. */
  newlyIneligible: Array<{ grantKey: string; title: string; beforeTier: string; failHardDimensions: string[] }>;
}

// ---- 메인 ----------------------------------------------------------------------

interface GrantShadowRecord {
  grantKey: string;
  grantId: string;
  title: string;
  status: string;
  run: { runId: string; promptVersion: string };
  /** 보조 지표(회사 무관): criteria 수·구조화(≠text_only) 수 A/B. */
  criteriaCountBefore: number;
  criteriaCountAfter: number;
  structuredBefore: number;
  structuredAfter: number;
  conversion: ShadowConversionReport;
  perCompany: Array<{
    /** 회사 고유 키(companyId/bizNo) — 동명 회사 행이 섞이지 않는 조인 키. */
    companyKey: string;
    companyLabel: string;
    before: CompactShadowMatch;
    after: CompactShadowMatch;
  }>;
}

async function main(): Promise<number> {
  const options = parseOptions();
  if (typeof options === "string") {
    console.error(`[shadow] 설정 오류: ${options}`);
    return 1;
  }

  // 1) 검수 런 수집 — reviewed-runs 공유 모듈. 게이트 집계(aggregate)와 달리 파일럿 층을
  //    제외하지 않는다: 섀도 측정은 "30건 검수 확정분"(확대 계획 §4)이고 확대 코호트 30건에
  //    보존된 파일럿 3건이 포함되기 때문이다(excludePilotStratum 은 게이트 표본 전용).
  const { reviewed: humanReviewed } = await selectReviewedRuns({
    scanAll: options.scanAll,
    excludePilotStratum: false,
  });
  // §9: "검수 확정분"에는 감사 완료된 AI 검수도 포함된다(30건 검수 확정분 정의 — 확대 계획
  // §4). 병합 결과가 LabReview 호환이므로 변환기(shadow-convert, correct 만 변환)는 무변경.
  // 같은 공고에 사람 검수가 있으면 사람 검수 우선. 감사 미완(대기)은 측정에서 제외한다.
  const audited = await loadAuditedConfirmedReviews({
    model: AI_REVIEW_ADOPTED.model,
    scanAll: options.scanAll,
  });
  const humanGrantIds = new Set(humanReviewed.map((item) => item.run.grantId));
  const auditedConfirmed = audited.confirmed.filter((item) => !humanGrantIds.has(item.run.grantId));
  if (auditedConfirmed.length > 0 || audited.pending.length > 0) {
    console.log(
      `[shadow] 감사 확정 AI 검수 ${auditedConfirmed.length}건 포함(§9, ${AI_REVIEW_ADOPTED.model}) · 감사 대기 ${audited.pending.length}건 제외`,
    );
  }
  const reviewed = [
    ...humanReviewed,
    ...auditedConfirmed.map(({ run, review }) => ({ run, review })),
  ];
  if (reviewed.length === 0) {
    console.error("[shadow] 검수된 런이 없습니다 — 검수 탭에서 판정 후 '검수 저장'을 눌러주세요.");
    if (!options.scanAll) console.error("[shadow] 코호트 밖 검수(파일럿 등)까지 포함하려면 --all 을 지정하세요.");
    return 1;
  }

  // 2) 공고 로딩 — 신규 listGrantsByIds(status 무관: 마감 공고도 측정 대상 유지).
  const db = getCunoteDb();
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grantIds = [...new Set(reviewed.map((item) => item.run.grantId))];
  const grants = await repositories.grants.listGrantsByIds(grantIds);
  const grantById = new Map(grants.flatMap((entry) => entry.grant.id ? [[entry.grant.id, entry] as const] : []));
  const missingGrantIds = grantIds.filter((id) => !grantById.has(id));
  for (const id of missingGrantIds) {
    const item = reviewed.find((candidate) => candidate.run.grantId === id);
    console.warn(
      `[shadow] 공고를 DB에서 찾지 못해 제외: ${item ? `${item.run.source}/${item.run.sourceId} (${item.run.title.slice(0, 40)})` : id}`,
    );
  }

  // 3) 회사 프로필 해석 — 기본 companies 전 행(system_recompute), --bizNo 는 캐시 익명 프로필.
  const companyProfiles = await resolveCompanyProfiles(options, db, repositories);
  if (typeof companyProfiles === "string") {
    console.error(`[shadow] ${companyProfiles}`);
    return 1;
  }

  // 4) 변환(후 변형) + 공고×회사 격자 전/후 섀도 매칭.
  const measurable = reviewed.filter((item) => grantById.has(item.run.grantId));
  if (measurable.length === 0) {
    console.error("[shadow] 측정 가능한 공고가 0건입니다 — 검수 런의 공고가 모두 DB에 없습니다.");
    return 1;
  }
  const records: GrantShadowRecord[] = [];
  interface PlannerCell {
    beforeItem: NormalizedGrant<unknown>;
    afterItem: NormalizedGrant<unknown>;
    beforeMatch: MatchResult;
    afterMatch: MatchResult;
    record: GrantShadowRecord;
  }
  const cellsByCompany = new Map<string, PlannerCell[]>();

  for (const { run, review } of measurable) {
    const entry = grantById.get(run.grantId)!;
    const conversion = convertReviewedLabRun(run, review);
    if (conversion.report.error) {
      console.warn(
        `[shadow] 변환 계약 실패(공고 단위 격리, 후 criteria 0건으로 측정): ${run.source}/${run.sourceId} · ${conversion.report.error.slice(0, 160)}`,
      );
    }
    const afterEntry = proposedEntryFor(entry, conversion.criteria);
    const record: GrantShadowRecord = {
      grantKey: `${entry.grant.source}:${entry.grant.source_id}`,
      grantId: run.grantId,
      title: entry.grant.title,
      status: entry.grant.status,
      run: { runId: run.runId, promptVersion: run.promptVersion },
      criteriaCountBefore: entry.criteria.length,
      criteriaCountAfter: conversion.criteria.length,
      structuredBefore: entry.criteria.filter((criterion) => criterion.operator !== "text_only").length,
      structuredAfter: conversion.criteria.filter((criterion) => criterion.operator !== "text_only").length,
      conversion: conversion.report,
      perCompany: [],
    };
    for (const company of companyProfiles) {
      const beforeMatch = buildGrantAnalysisShadowMatch({
        entry,
        criteria: entry.criteria,
        company: company.profile,
        asOf: options.asOf,
      });
      const afterMatch = buildGrantAnalysisShadowMatch({
        entry,
        criteria: conversion.criteria,
        company: company.profile,
        asOf: options.asOf,
      });
      record.perCompany.push({
        companyKey: company.key,
        companyLabel: company.label,
        before: compactShadowMatch(beforeMatch, entry.criteria),
        after: compactShadowMatch(afterMatch, conversion.criteria),
      });
      const cells = cellsByCompany.get(company.key) ?? [];
      cells.push({ beforeItem: entry, afterItem: afterEntry, beforeMatch, afterMatch, record });
      cellsByCompany.set(company.key, cells);
    }
    records.push(record);
  }

  // 5) 회사별 지표 4종 + 전체 집계.
  const perCompany: CompanyMetrics[] = companyProfiles.map((company) =>
    computeCompanyMetrics(company, cellsByCompany.get(company.key) ?? [], options.asOf));
  const conversionTotals = sumConversionReports(records.map((record) => record.conversion));
  const caveats = [
    `후(after) 지표는 하한 추정이다 — 검수가 확인한 누락 조건(missed_condition) ${conversionTotals.missedConditions}건과 ` +
      `수정 필요(needs_edit) ${conversionTotals.needsEdit}건은 구조화 값이 없어 섀도에 반영하지 않았다.`,
    "섀도 결과는 진단 전용 — 게이트·승격 판단은 확대 실험 계획의 사전 등록 절차를 따른다.",
  ];

  // 6) 보고서 저장(spike-out 밖 쓰기 금지) + stdout 요약.
  const stamp = new Date().toISOString().replace(/:/g, "");
  const outputDir = join(analysisLabDir(), "shadow", stamp);
  const reportPath = join(outputDir, "shadow-report.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    recordType: "analysis_lab_shadow_report",
    generatedAt: new Date().toISOString(),
    asOf: options.asOf.toISOString(),
    scanAll: options.scanAll,
    databaseWriteMode: false,
    externalCalls: 0,
    /** §9 — 검수 확정분 중 감사 확정 AI 검수로 편입된 공고 수와 감사 대기(제외) 수. */
    auditedConfirmedGrantCount: auditedConfirmed.length,
    auditPendingGrantCount: audited.pending.length,
    grantCount: records.length,
    missingGrantIds,
    companies: companyProfiles.map((company) => ({ label: company.label, identity: company.identity })),
    caveats,
    conversionTotals,
    grants: records,
    perCompany,
    aggregate: aggregateCompanyMetrics(perCompany),
  }, null, 2)}\n`, "utf8");

  printSummary({ records, perCompany, conversionTotals, caveats, options, reportPath });
  return 0;
}

// ---- 회사 프로필 --------------------------------------------------------------

interface ResolvedCompany {
  /** 고유 조인 키 — 동명 회사 행이 있어도 지표가 섞이지 않아야 한다(companyId/bizNo 기반). */
  key: string;
  label: string;
  /** 보고서 파일용 식별자(재현성) — companyId 또는 bizNo. spike-out 은 로컬 산출물이다. */
  identity: { kind: "company"; companyId: string } | { kind: "bizNo"; bizNo: string };
  profile: CompanyProfile;
}

async function resolveCompanyProfiles(
  options: ShadowOptions,
  db: ReturnType<typeof getCunoteDb>,
  repositories: ReturnType<typeof createDrizzleRepositories<unknown>>,
): Promise<ResolvedCompany[] | string> {
  const asOfIso = options.asOf.toISOString();
  const resolved: ResolvedCompany[] = [];

  // 기본: companies 전 행 — system_recompute(저장 프로필 DB read, 외부 호출 없음).
  const companyRows = await db
    .select({ id: schema.companies.id, name: schema.companies.name })
    .from(schema.companies);
  const unknownCompanyIds = options.companyIds.filter((id) => !companyRows.some((row) => row.id === id));
  if (unknownCompanyIds.length > 0) {
    return `--companyId 에 지정한 회사를 찾지 못했습니다: ${unknownCompanyIds.join(", ")}`;
  }
  const targets = options.companyIds.length > 0
    ? companyRows.filter((row) => options.companyIds.includes(row.id))
    : companyRows;
  for (const row of targets) {
    try {
      const resolution = await resolveSystemProductCompanyProfile(
        { companyId: row.id, asOf: asOfIso },
        { companies: repositories.companies, enrichmentCache: repositories.enrichmentCache },
      );
      resolved.push({
        key: `company:${row.id}`,
        label: `company:${row.id.slice(0, 8)}${row.name ? `(${row.name})` : ""}`,
        identity: { kind: "company", companyId: row.id },
        profile: resolution.profile,
      });
    } catch (caught) {
      console.warn(
        `[shadow] 회사 프로필 해석 실패 — 제외: ${row.id} · ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }

  // --bizNo: 팝빌 등 enrichment 캐시 기반 익명 프로필(anonymous_teaser, cache_only —
  // 캐시가 없으면 503 으로 실패할 뿐 외부 fetch 는 없다. 07-15 파일럿 선례).
  if (options.bizNos.length > 0) {
    // serviceData 는 import 시점에 repository mode 를 고르므로 env 로드 뒤 동적 import 필수
    // (run-grant-analysis-pilot.ts:45-47 주석과 동일 이유).
    const { resolveAnonymousProductCompanyProfile } = await import("../serviceData");
    for (const bizNo of options.bizNos) {
      try {
        const resolution = await resolveAnonymousProductCompanyProfile({ bizNo }, { asOf: options.asOf });
        resolved.push({
          key: `bizNo:${bizNo}`,
          label: `bizNo:${safeMaskBizNo(bizNo)}`,
          identity: { kind: "bizNo", bizNo },
          profile: resolution.profile,
        });
      } catch (caught) {
        console.warn(
          `[shadow] 사업자번호 프로필 해석 실패(캐시 부재 가능) — 제외: ${safeMaskBizNo(bizNo)} · ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
  }

  if (resolved.length === 0) {
    return options.bizNos.length > 0 || companyRows.length > 0
      ? "매칭할 회사 프로필을 하나도 해석하지 못했습니다 — 위 경고를 확인해주세요."
      : "매칭할 회사가 없습니다 — companies 테이블이 비어 있고 --bizNo 도 지정되지 않았습니다. 팝빌 캐시가 있는 사업자번호로 --bizNo=<10자리> 를 지정해주세요.";
  }
  return resolved;
}

function safeMaskBizNo(bizNo: string): string {
  try {
    return maskCorpNum(bizNo);
  } catch {
    return `${bizNo.slice(0, 3)}*******`;
  }
}

// ---- 지표 계산 ----------------------------------------------------------------

function computeCompanyMetrics(
  company: { key: string; label: string },
  cells: Array<{
    beforeItem: NormalizedGrant<unknown>;
    afterItem: NormalizedGrant<unknown>;
    beforeMatch: MatchResult;
    afterMatch: MatchResult;
    record: GrantShadowRecord;
  }>,
  asOf: Date,
): CompanyMetrics {
  const tierMatrix: Record<string, number> = {};
  const eligibilityMatrix: Record<string, number> = {};
  let tierUp = 0;
  let tierDown = 0;
  let eligUp = 0;
  let eligDown = 0;
  const newlyIneligible: CompanyMetrics["newlyIneligible"] = [];

  const compactPairs = cells.map((cell) => {
    const pair = cell.record.perCompany.find((item) => item.companyKey === company.key)!;
    return { cell, before: pair.before, after: pair.after };
  });

  for (const { cell, before, after } of compactPairs) {
    bump(tierMatrix, `${before.tier}→${after.tier}`);
    bump(eligibilityMatrix, `${before.eligibility}→${after.eligibility}`);
    if (before.tier !== "recommendable" && after.tier === "recommendable") tierUp += 1;
    if (before.tier === "recommendable" && after.tier !== "recommendable") tierDown += 1;
    if (before.eligibility !== "eligible" && after.eligibility === "eligible") eligUp += 1;
    if (before.eligibility === "eligible" && after.eligibility !== "eligible") eligDown += 1;
    if (before.eligibility !== "ineligible" && after.eligibility === "ineligible") {
      newlyIneligible.push({
        grantKey: cell.record.grantKey,
        title: cell.record.title,
        beforeTier: before.tier,
        failHardDimensions: after.failHardDimensions,
      });
    }
  }

  const variant = (side: "before" | "after"): CompanyVariantMetrics => {
    const compacts = compactPairs.map((pair) => pair[side]);
    const decidedTotal = compacts.reduce((sum, item) => sum + item.decided, 0);
    const matches = cells.map((cell) => ({
      item: side === "before" ? cell.beforeItem : cell.afterItem,
      match: side === "before" ? cell.beforeMatch : cell.afterMatch,
    }));
    const topQuestions = planProfileQuestions(matches, { asOf, limit: 3 }).map((planned) => ({
      dimension: planned.question.dimension,
      affectedGrantCount: planned.question.affectedGrantCount,
      resolvesGrantCount: planned.resolvesGrantCount,
      prompt: planned.question.prompt,
    }));
    return {
      decidedTotal,
      decidedMeanPerGrant: cells.length > 0 ? decidedTotal / cells.length : 0,
      singleQuestionResolvableGrants: compacts.filter((item) => item.singleQuestionResolvable).length,
      topQuestions,
    };
  };

  return {
    companyKey: company.key,
    companyLabel: company.label,
    grantCount: cells.length,
    before: variant("before"),
    after: variant("after"),
    tierMatrix,
    eligibilityMatrix,
    tierUpToRecommendable: tierUp,
    tierDownFromRecommendable: tierDown,
    eligibilityUpToEligible: eligUp,
    eligibilityDownFromEligible: eligDown,
    newlyIneligible,
  };
}

interface AggregateMetrics {
  companyCount: number;
  grantCompanyPairs: number;
  decidedTotalBefore: number;
  decidedTotalAfter: number;
  decidedMeanPerGrantBefore: number;
  decidedMeanPerGrantAfter: number;
  tierMatrix: Record<string, number>;
  eligibilityMatrix: Record<string, number>;
  tierUpToRecommendable: number;
  tierDownFromRecommendable: number;
  eligibilityUpToEligible: number;
  eligibilityDownFromEligible: number;
  singleQuestionResolvableBefore: number;
  singleQuestionResolvableAfter: number;
  newlyIneligiblePairs: number;
  newlyIneligibleFailDimensions: Record<string, number>;
}

function aggregateCompanyMetrics(perCompany: CompanyMetrics[]): AggregateMetrics {
  const tierMatrix: Record<string, number> = {};
  const eligibilityMatrix: Record<string, number> = {};
  const failDimensions: Record<string, number> = {};
  let pairs = 0;
  for (const company of perCompany) {
    pairs += company.grantCount;
    for (const [key, count] of Object.entries(company.tierMatrix)) bump(tierMatrix, key, count);
    for (const [key, count] of Object.entries(company.eligibilityMatrix)) bump(eligibilityMatrix, key, count);
    for (const entry of company.newlyIneligible) {
      for (const dimension of entry.failHardDimensions) bump(failDimensions, dimension);
    }
  }
  const decidedTotalBefore = sum(perCompany.map((company) => company.before.decidedTotal));
  const decidedTotalAfter = sum(perCompany.map((company) => company.after.decidedTotal));
  return {
    companyCount: perCompany.length,
    grantCompanyPairs: pairs,
    decidedTotalBefore,
    decidedTotalAfter,
    decidedMeanPerGrantBefore: pairs > 0 ? decidedTotalBefore / pairs : 0,
    decidedMeanPerGrantAfter: pairs > 0 ? decidedTotalAfter / pairs : 0,
    tierMatrix,
    eligibilityMatrix,
    tierUpToRecommendable: sum(perCompany.map((company) => company.tierUpToRecommendable)),
    tierDownFromRecommendable: sum(perCompany.map((company) => company.tierDownFromRecommendable)),
    eligibilityUpToEligible: sum(perCompany.map((company) => company.eligibilityUpToEligible)),
    eligibilityDownFromEligible: sum(perCompany.map((company) => company.eligibilityDownFromEligible)),
    singleQuestionResolvableBefore: sum(perCompany.map((company) => company.before.singleQuestionResolvableGrants)),
    singleQuestionResolvableAfter: sum(perCompany.map((company) => company.after.singleQuestionResolvableGrants)),
    newlyIneligiblePairs: sum(perCompany.map((company) => company.newlyIneligible.length)),
    newlyIneligibleFailDimensions: failDimensions,
  };
}

interface ConversionTotals {
  correct: number;
  needsEdit: number;
  wrong: number;
  unsure: number;
  missedConditions: number;
  inputRows: number;
  converted: number;
  downgraded: number;
  dropped: number;
  failedGrants: number;
}

function sumConversionReports(reports: ShadowConversionReport[]): ConversionTotals {
  return {
    correct: sum(reports.map((report) => report.verdicts.correct)),
    needsEdit: sum(reports.map((report) => report.verdicts.needs_edit)),
    wrong: sum(reports.map((report) => report.verdicts.wrong)),
    unsure: sum(reports.map((report) => report.verdicts.unsure)),
    missedConditions: sum(reports.map((report) => report.missedConditions)),
    inputRows: sum(reports.map((report) => report.inputRows)),
    converted: sum(reports.map((report) => report.converted)),
    downgraded: sum(reports.map((report) => report.downgraded)),
    dropped: sum(reports.map((report) => report.dropped)),
    failedGrants: reports.filter((report) => report.error !== null).length,
  };
}

// ---- 출력 ----------------------------------------------------------------------

function matrixText(matrix: Record<string, number>): string {
  const entries = Object.entries(matrix).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "—";
  return entries.map(([key, count]) => `${key} ${count}건`).join(" · ");
}

function questionsText(questions: TopQuestionSummary[]): string {
  if (questions.length === 0) return "—";
  return questions
    .map((question) => `${question.dimension}(영향 ${question.affectedGrantCount}·확정 ${question.resolvesGrantCount})`)
    .join(" · ");
}

function printSummary(input: {
  records: GrantShadowRecord[];
  perCompany: CompanyMetrics[];
  conversionTotals: ConversionTotals;
  caveats: string[];
  options: ShadowOptions;
  reportPath: string;
}): void {
  const { records, perCompany, conversionTotals: totals, options } = input;
  const aggregate = aggregateCompanyMetrics(perCompany);
  console.log(
    `\n===== 매칭 임팩트 섀도 — 공고 ${records.length}건 × 회사 ${perCompany.length}곳 ` +
      `(asOf ${options.asOf.toISOString()}${options.scanAll ? " · 전수(--all)" : " · 코호트"}) =====`,
  );
  console.log(
    `[변환] correct ${totals.correct}건 → 변환 ${totals.converted}건(강등 ${totals.downgraded} · 탈락 ${totals.dropped}` +
      `${totals.failedGrants > 0 ? ` · 계약 실패 공고 ${totals.failedGrants}` : ""})` +
      ` | 미반영: 수정 ${totals.needsEdit} · 오류 ${totals.wrong} · 판단불가 ${totals.unsure} · 누락 조건 ${totals.missedConditions}`,
  );
  const criteriaBefore = sum(records.map((record) => record.criteriaCountBefore));
  const criteriaAfter = sum(records.map((record) => record.criteriaCountAfter));
  const structuredBefore = sum(records.map((record) => record.structuredBefore));
  const structuredAfter = sum(records.map((record) => record.structuredAfter));
  console.log(
    `[보조] 공고당 criteria 전 ${criteriaBefore}건(구조화 ${structuredBefore}) → 후 ${criteriaAfter}건(구조화 ${structuredAfter})`,
  );
  console.log(
    `[지표1] 확정 판정(pass|fail) 조건 수 — 합계 전 ${aggregate.decidedTotalBefore} → 후 ${aggregate.decidedTotalAfter}` +
      ` · 공고×회사당 평균 전 ${aggregate.decidedMeanPerGrantBefore.toFixed(2)} → 후 ${aggregate.decidedMeanPerGrantAfter.toFixed(2)}`,
  );
  console.log(
    `[지표2] tier 전이: ${matrixText(aggregate.tierMatrix)}\n` +
      `        eligibility 전이: ${matrixText(aggregate.eligibilityMatrix)}\n` +
      `        recommendable 상승 ${aggregate.tierUpToRecommendable} · 이탈 ${aggregate.tierDownFromRecommendable}` +
      ` | eligible 상승 ${aggregate.eligibilityUpToEligible} · 이탈 ${aggregate.eligibilityDownFromEligible}`,
  );
  console.log(
    `[지표3] 질문 1개로 확정 가능 — 전 ${aggregate.singleQuestionResolvableBefore} → 후 ${aggregate.singleQuestionResolvableAfter}(공고×회사)`,
  );
  console.log(
    `[지표4] 신규 ineligible(전 ≠ineligible → 후 ineligible) ${aggregate.newlyIneligiblePairs}건` +
      ` · 후 hard fail 축: ${matrixText(aggregate.newlyIneligibleFailDimensions)}`,
  );

  // 회사가 많은 dev DB(수십~수백 행)에서 stdout 폭주를 막는다 — 상세는 --verbose 또는 보고서.
  const COMPANY_BLOCK_LIMIT = 12;
  const printable = options.verbose ? perCompany : perCompany.slice(0, COMPANY_BLOCK_LIMIT);
  for (const company of printable) {
    console.log(`\n----- ${company.companyLabel} — 공고 ${company.grantCount}건 -----`);
    console.log(
      `  지표1 확정 조건: 전 합계 ${company.before.decidedTotal}(평균 ${company.before.decidedMeanPerGrant.toFixed(2)})` +
        ` → 후 합계 ${company.after.decidedTotal}(평균 ${company.after.decidedMeanPerGrant.toFixed(2)})`,
    );
    console.log(`  지표2 tier: ${matrixText(company.tierMatrix)} | eligibility: ${matrixText(company.eligibilityMatrix)}`);
    console.log(
      `  지표3 질문1개 확정: 전 ${company.before.singleQuestionResolvableGrants} → 후 ${company.after.singleQuestionResolvableGrants}` +
        ` | 상위 질문(후): ${questionsText(company.after.topQuestions)}`,
    );
    console.log(
      `  지표4 신규 ineligible ${company.newlyIneligible.length}건` +
        (company.newlyIneligible.length > 0
          ? ` — ${company.newlyIneligible.map((entry) => `${entry.grantKey}(${entry.failHardDimensions.join(",") || "축 정보 없음"})`).join(" · ")}`
          : ""),
    );
    if (options.verbose) {
      for (const record of records) {
        const pair = record.perCompany.find((item) => item.companyKey === company.companyKey);
        if (!pair) continue;
        console.log(
          `    [${record.grantKey}] ${record.title.slice(0, 40)} — ` +
            `전 ${pair.before.eligibility}/${pair.before.tier}(pass ${pair.before.pass}·fail ${pair.before.fail}·hard? ${pair.before.unknownHard})` +
            ` → 후 ${pair.after.eligibility}/${pair.after.tier}(pass ${pair.after.pass}·fail ${pair.after.fail}·hard? ${pair.after.unknownHard})` +
            `${pair.after.singleQuestionResolvable ? " · 질문1개확정" : ""}`,
        );
      }
    }
  }
  if (printable.length < perCompany.length) {
    console.log(
      `\n(회사 ${perCompany.length - printable.length}곳 상세 생략 — 전체는 --verbose 또는 보고서 JSON 참조)`,
    );
  }

  console.log("");
  for (const caveat of input.caveats) console.log(`caveat: ${caveat}`);
  console.log(`보고서: ${input.reportPath}`);
}

// ---- 유틸 ----------------------------------------------------------------------

function bump(record: Record<string, number>, key: string, count = 1): void {
  record[key] = (record[key] ?? 0) + count;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** DB 커넥션이 열렸으면 닫는다 — verify 계열 미종료 전례 방지(batch.ts 관행). */
async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 커넥션 정리 실패는 종료를 막지 않는다
  }
}

main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[shadow] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });

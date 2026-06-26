import type { CompanyProfile, CriterionDimension, DashboardResult, NormalizedGrant } from "@cunote/contracts";
import { matchGrantCriteria } from "../matching/match.js";
import { REGION_CODES } from "../kstartup/constants.js";
import { buildActionQueue } from "./build-action-queue.js";
import { buildRoadmap } from "./build-roadmap.js";
import { buildTeaser } from "./build-teaser.js";
import {
  companySummary,
  sortMatchedGrants,
  toMatchCard,
  type MatchedGrant,
} from "./match-card.js";

export interface BuildDashboardOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  limit?: number;
}

export function buildDashboard<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 24,
}: BuildDashboardOptions<TPayload>): DashboardResult {
  const teaser = buildTeaser({ company, grants, asOf, limit });
  const matched = grants.map<MatchedGrant<TPayload>>((item) => ({
    item,
    match: matchGrantCriteria(item.criteria, company),
  }));
  const matches = sortMatchedGrants(matched).slice(0, limit).map((entry) => toMatchCard(entry, { asOf }));
  const nextQuestion = nextQuestionFromMatches(matches);

  const dashboard: DashboardResult = {
    company: companySummary(company),
    counts: teaser.counts,
    matches,
    roadmap: buildRoadmap({ matches }),
    actionQueue: buildActionQueue({ matches }),
    rulesetVer: matches[0]?.rulesetVer ?? "unknown",
    scoringVer: matches[0]?.scoringVer ?? "unknown",
  };
  if (nextQuestion) dashboard.nextQuestion = nextQuestion;
  return dashboard;
}

function nextQuestionFromMatches(matches: DashboardResult["matches"]): DashboardResult["nextQuestion"] {
  const unknown = matches.flatMap((match) =>
    match.ruleTrace
      .filter((trace) => trace.result === "unknown")
      .map((trace) => ({ trace, grantId: match.grantId }))
  );
  const first = unknown[0];
  if (!first) return undefined;
  const sameDimension = unknown.filter((entry) => entry.trace.dimension === first.trace.dimension);
  const inputType = inputTypeForDimension(first.trace.dimension);
  const options = optionsForDimension(first.trace.dimension);
  const question: NonNullable<DashboardResult["nextQuestion"]> = {
    dimension: first.trace.dimension,
    prompt: `${dimensionLabel(first.trace.dimension)} 정보를 확인해 주세요.`,
    inputType,
    framing: `${sameDimension.length}개 조건부 판단을 확정 또는 제외하는 데 도움이 됩니다.`,
    affectedGrantCount: new Set(sameDimension.map((entry) => entry.grantId)).size,
  };
  if (options.length > 0) question.options = options;

  return question;
}

function inputTypeForDimension(dimension: CriterionDimension): NonNullable<DashboardResult["nextQuestion"]>["inputType"] {
  if (dimension === "biz_age" || dimension === "founder_age" || dimension === "revenue" || dimension === "employees") {
    return "number";
  }
  if (dimension === "business_status") return "boolean";
  if (dimension === "region" || dimension === "industry" || dimension === "size" || dimension === "target_type") {
    return "select";
  }
  return "text";
}

function optionsForDimension(dimension: CriterionDimension): string[] {
  if (dimension === "region") return Object.keys(REGION_CODES);
  if (dimension === "size") return ["소상공인", "중소", "중견", "대기업"];
  if (dimension === "industry") return ["ICT", "SW", "AI", "바이오", "제조", "콘텐츠", "패션", "해양", "기타"];
  if (dimension === "target_type") return ["예비창업자", "개인사업자", "법인", "일반기업", "1인 창조기업", "대학", "연구기관"];
  return [];
}

function dimensionLabel(dimension: CriterionDimension): string {
  const labels: Record<CriterionDimension, string> = {
    region: "지역",
    biz_age: "업력",
    industry: "업종",
    size: "기업규모",
    revenue: "매출",
    employees: "고용",
    founder_age: "대표자 연령",
    founder_trait: "대표자 속성",
    certification: "인증",
    prior_award: "기수혜",
    ip: "지식재산",
    target_type: "신청대상",
    business_status: "영업상태",
    other: "기타 조건",
  };
  return labels[dimension];
}

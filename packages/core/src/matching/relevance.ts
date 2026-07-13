import type { CompanyProfile, Grant, GrantCriterion } from "@cunote/contracts";
import { expandKsicCodes, isLikelyKsicCode } from "../industry/ksic.js";
import { projectGrantIndustryTags } from "../grants/industry-projection.js";

export interface RelevanceResult {
  score: number | null;
  reasons: string[];
}

const GOAL_ALIASES: ReadonlyArray<{ canonical: string; pattern: RegExp }> = [
  { canonical: "사업화", pattern: /사업화|창업|제품화|상용화/ },
  { canonical: "R&D", pattern: /r&d|연구개발|기술개발|실증/i },
  { canonical: "수출", pattern: /수출|해외|글로벌|판로/ },
  { canonical: "자금", pattern: /자금|융자|보증|투자/ },
  { canonical: "고용", pattern: /고용|인력|채용/ },
  { canonical: "공간", pattern: /공간|입주|보육|센터/ },
  { canonical: "역량강화", pattern: /교육|컨설팅|멘토링|역량/ },
  { canonical: "인증", pattern: /인증|특허|지식재산/ },
];

/** 지역·업력을 의도적으로 제외한 설명 가능한 관련성 v1. */
export function calculateRelevance(
  company: CompanyProfile,
  grant: Grant,
  criteria: GrantCriterion[] = [],
): RelevanceResult {
  const companyIndustries = uniqueStrings(company.industries ?? []);
  const companyCodes = expandCodes(company.industry_codes ?? []);
  const grantIndustryValues = uniqueStrings([
    ...(grant.f_industries ?? []),
    ...projectGrantIndustryTags(criteria),
  ]);
  const grantCodes = expandCodes(grantIndustryValues.filter(isLikelyKsicCode));
  const grantText = [grant.title, grant.category_l1, grant.category_l2, ...grantIndustryValues]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const goalText = [grant.title, grant.category_l1, grant.category_l2]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  const companyTokens = tokenize(companyIndustries.join(" "));
  const grantTokens = tokenize(grantText);
  const exactLabels = intersect(
    companyIndustries.map(normalizeText),
    grantIndustryValues.map(normalizeText),
  );
  const codeOverlap = intersect(companyCodes, grantCodes);
  const keywordOverlap = intersect(companyTokens, grantTokens);
  const goals = readProfileGoals(company);
  const matchedGoals = goals.filter((goal) => goalPattern(goal).test(goalText));

  const components: Array<{ score: number; weight: number }> = [];
  if (companyIndustries.length > 0 || companyCodes.length > 0) {
    const hasGrantIndustrySignal = grantIndustryValues.length > 0 || keywordOverlap.length > 0;
    if (hasGrantIndustrySignal) {
      const industryScore = exactLabels.length > 0 || codeOverlap.length > 0
        ? 100
        : keywordOverlap.length > 0
          ? Math.min(85, 55 + keywordOverlap.length * 10)
          : 0;
      components.push({ score: industryScore, weight: 70 });
    }
  }
  if (goals.length > 0) {
    components.push({ score: matchedGoals.length > 0 ? 100 : 0, weight: 30 });
  }

  if (components.length === 0) {
    return { score: null, reasons: ["관련성 계산에 필요한 업종 또는 관심 목표 정보가 부족해요."] };
  }

  const score = Math.round(
    components.reduce((sum, component) => sum + component.score * component.weight, 0) / 100,
  );
  const reasons: string[] = [];
  const industryMatches = uniqueStrings([...exactLabels, ...codeOverlap, ...keywordOverlap]).slice(0, 2);
  if (industryMatches.length > 0) reasons.push(`업종 연관 신호: ${industryMatches.map(industryTokenLabel).join(", ")}`);
  if (matchedGoals.length > 0) reasons.push(`관심 목표와 일치: ${matchedGoals.slice(0, 2).join(", ")}`);
  if (reasons.length === 0) reasons.push("회사 업종·관심 목표와 직접 일치하는 신호가 적어요.");
  return { score, reasons };
}

function readProfileGoals(company: CompanyProfile): string[] {
  const source = company.other_conditions ?? {};
  return uniqueStrings([
    ...collectStrings(source.interest_goals),
    ...collectStrings(source.support_goals),
    ...collectStrings(source.goals),
  ]).map(canonicalGoal);
}

function canonicalGoal(value: string): string {
  return GOAL_ALIASES.find((entry) => entry.pattern.test(value))?.canonical ?? value.trim();
}

function goalPattern(goal: string): RegExp {
  return GOAL_ALIASES.find((entry) => entry.canonical === goal)?.pattern ?? new RegExp(escapeRegExp(goal), "i");
}

function expandCodes(values: string[]): string[] {
  return uniqueStrings(values.flatMap((value) => expandKsicCodes(value)));
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
}

function tokenize(value: string): string[] {
  return uniqueStrings(
    value
      .toLowerCase()
      .split(/[^0-9a-z가-힣]+/u)
      .map((token) => token.replace(/(?:산업|사업|서비스|제조|업)$/u, ""))
      .map(canonicalIndustryToken)
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  );
}

function canonicalIndustryToken(token: string): string {
  if (/^(?:sw|it|소프트웨어|정보통신|정보서비스)$/i.test(token)) return "software";
  if (/^(?:식료품|식품|농식품)$/u.test(token)) return "food";
  if (/^(?:음식점|외식)$/u.test(token)) return "foodservice";
  if (/^(?:인공지능|ai)$/i.test(token)) return "ai";
  if (/^(?:헬스케어|디지털헬스케어)$/u.test(token)) return "healthcare";
  return token;
}

function industryTokenLabel(token: string): string {
  const labels: Record<string, string> = {
    software: "소프트웨어",
    food: "식품",
    foodservice: "외식",
    ai: "AI",
    healthcare: "헬스케어",
  };
  return labels[token] ?? token;
}

// 여러 업종에 공통으로 등장하는 범용어는 관련성 근거로 쓰지 않는다.
const STOP_WORDS = new Set([
  "지원",
  "공고",
  "모집",
  "기업",
  "중소기업",
  "창업기업",
  "대상",
  "분야",
  "개발",
  "제조",
  "산업",
  "사업",
  "서비스",
  "기술",
  "제품",
]);

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-z가-힣]/gu, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return uniqueStrings(left.filter((value) => rightSet.has(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

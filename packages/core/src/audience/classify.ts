import type { GrantAudience, GrantSource } from "@cunote/contracts";

export interface GrantAudienceClassificationInput {
  source: GrantSource;
  title: string;
  payload: unknown;
}

export interface GrantAudienceClassification {
  audience: GrantAudience;
  confidence: number;
  stage: "structured" | "rule" | "unknown";
  safeToExcludeFromBusinessMatching: boolean;
  signals: string[];
}

const STRUCTURED_COMPANY_TOKENS = [
  "일반기업", "1인 창조기업", "연구기관", "대학", "창업기업", "중소기업", "소상공인", "기업",
] as const;
const STRUCTURED_INDIVIDUAL_TOKENS = [
  "일반인", "청소년", "대학생", "예비창업자", "재직자", "직장인",
] as const;
const COMPANY_PATTERNS = [
  /(?:중소|중견|대|창업|입주|참여|지원대상)?기업/u,
  /법인(?:사업자)?/u,
  /(?:개인|법인)?사업자/u,
  /소상공인/u,
  /협동조합/u,
  /연구기관/u,
] as const;
const INDIVIDUAL_RULE_PATTERNS = [
  /청소년비즈쿨/u,
  /(?:청소년|대학생|일반인|재직자|직장인|심사역|심사위원|수강생|교육생)\s*(?:만|을|를|에게|대상|모집|과정)/u,
  /만\s*\d{1,2}\s*세(?:\s*(?:이상|이하|미만|초과))?/u,
  /예비창업자\s*(?:만|에\s*한함|대상|모집)/u,
] as const;
const MIXED_PATTERNS = [
  /예비창업자[\s\S]{0,40}(?:및|또는|·|ㆍ)[\s\S]{0,40}창업기업/u,
  /창업기업[\s\S]{0,40}(?:및|또는|·|ㆍ)[\s\S]{0,40}예비창업자/u,
  /(?:^|[^\p{L}])개인\s*(?:ㆍ|·|,|및|또는)\s*기업(?:이|가|은|는|을|를|에게)?(?:[^\p{L}]|$)/u,
  /(?:^|[^\p{L}])기업\s*(?:ㆍ|·|,|및|또는)\s*개인(?:이|가|은|는|을|를|에게)?(?:[^\p{L}]|$)/u,
] as const;

export function classifyGrantAudience(input: GrantAudienceClassificationInput): GrantAudienceClassification {
  const payload = asRecord(input.payload);
  const targetField = input.source === "kstartup" ? text(payload.aply_trgt) : text(payload.trgetNm);
  const targetDetail = input.source === "kstartup" ? text(payload.aply_trgt_ctnt) : text(payload.bsnsSumryCn);
  const structuredTokens = tokenizeTarget(targetField);
  const structuredCompany = matchTokens(structuredTokens, STRUCTURED_COMPANY_TOKENS);
  const structuredIndividual = matchTokens(structuredTokens, STRUCTURED_INDIVIDUAL_TOKENS);
  const companyText = [input.title, targetField, targetDetail].filter(Boolean).join(" ");
  const companyRules = matchPatterns(companyText, COMPANY_PATTERNS, "company");
  const companySignals = unique([
    ...structuredCompany.map((value) => `structured:company:${value}`),
    ...companyRules,
  ]);
  const individualStructuredSignals = structuredIndividual.map((value) => `structured:individual:${value}`);
  const individualRuleText = [input.title, targetDetail].filter(Boolean).join(" ");
  const individualRules = matchPatterns(individualRuleText, INDIVIDUAL_RULE_PATTERNS, "individual");
  const mixedRules = matchPatterns(individualRuleText, MIXED_PATTERNS, "mixed");

  if (companySignals.length > 0 && mixedRules.length > 0) {
    return result("mixed", 0.95, "structured", false, [
      ...companySignals,
      ...individualStructuredSignals,
      ...mixedRules,
    ]);
  }
  if (companySignals.length > 0) {
    return result("company", 0.95, structuredCompany.length > 0 ? "structured" : "rule", false, companySignals);
  }
  if (individualStructuredSignals.length > 0 && individualRules.length > 0) {
    return result("individual", 0.96, "structured", true, [...individualStructuredSignals, ...individualRules]);
  }
  if (individualRules.length > 0) return result("individual", 0.9, "rule", true, individualRules);
  return result("unknown", 0, "unknown", false, individualStructuredSignals.map((signal) => `candidate:${signal}`));
}

function result(
  audience: GrantAudience,
  confidence: number,
  stage: GrantAudienceClassification["stage"],
  safeToExcludeFromBusinessMatching: boolean,
  signals: string[],
): GrantAudienceClassification {
  return { audience, confidence, stage, safeToExcludeFromBusinessMatching, signals: unique(signals) };
}

function tokenizeTarget(value: string): string[] {
  return unique(value
    .split(/[\n,;/|·ㆍ]+/u)
    .map((token) => token.replace(/^[\s\[\](){}]+|[\s\[\](){}]+$/gu, "").trim())
    .filter(Boolean));
}

function matchTokens(tokens: string[], candidates: readonly string[]): string[] {
  return candidates.filter((candidate) => tokens.some((token) => token === candidate));
}

function matchPatterns(value: string, patterns: readonly RegExp[], prefix: string): string[] {
  return patterns.filter((pattern) => pattern.test(value)).map((pattern) => `${prefix}:${pattern.source}`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

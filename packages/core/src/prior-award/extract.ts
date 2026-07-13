import type { GrantCriterion, PriorAwardCriterionValue, PriorAwardSelfKind, PriorAwardState } from "@cunote/contracts";
import { splitDisqualificationSentences } from "../disqualification/extract.js";
import { CANONICAL_PRIOR_AWARD_PROGRAMS } from "./canonical.js";

export interface PriorAwardExtractionResult {
  criteria: Array<Omit<GrantCriterion, "id" | "grant_id" | "parser_version">>;
  consumedSpans: string[];
  residualSpans: string[];
}

/**
 * P3 준비용 독립 splitter. enabled 기본값은 false라 L1 방어층을 해제하지 않는다.
 * P5에서 normalizer가 명시적으로 enabled=true를 전달하는 배포와 골든 검증을 함께 수행한다.
 */
export function extractPriorAwardCriteria(
  text: string,
  options: { enabled?: boolean; sourceField?: string; confidence?: number } = {},
): PriorAwardExtractionResult {
  const sentences = splitDisqualificationSentences(text).flatMap(splitPriorAwardCandidateClauses);
  if (options.enabled !== true) return { criteria: [], consumedSpans: [], residualSpans: sentences };
  const criteria: PriorAwardExtractionResult["criteria"] = [];
  const consumedSpans: string[] = [];
  const residualSpans: string[] = [];
  for (const sentence of sentences) {
    const value = parsePriorAwardSentence(sentence);
    if (!value) {
      residualSpans.push(sentence);
      continue;
    }
    consumedSpans.push(sentence);
    criteria.push({
      dimension: "prior_award",
      operator: value.scope === "self" ? "exists" : "in",
      kind: "exclusion",
      value,
      confidence: options.confidence ?? 0.6,
      source_field: options.sourceField ?? "aply_excl_trgt_ctnt",
      source_span: sentence,
      needs_review: true,
    });
  }
  return { criteria, consumedSpans, residualSpans };
}

/**
 * API가 여러 배제 항목을 한 줄로 붙인 경우 prior_award 절과 절차·업종·제재 절을 다시 분리한다.
 * 파싱된 절만 consumed로 보내고 나머지는 residual에 남겨 unrelated 조건 유실을 막는다.
 */
export function splitPriorAwardCandidateClauses(sentence: string): string[] {
  const parts = sentence
    .split(PRIOR_AWARD_CLAUSE_BOUNDARY)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  return parts.length > 0 ? parts : [sentence];
}

export function parsePriorAwardSentence(sentence: string): PriorAwardCriterionValue | null {
  const text = sentence.trim();
  if (!text) return null;
  if (PRIOR_AWARD_HEADING_ONLY.test(text)) return null;
  if (PRIOR_AWARD_PROCEDURAL_NOTICE.test(text)) return null;
  // 금액·동시 과제 수 임계는 현행 prior_award 값 스키마로 표현할 수 없다. 넓은 boolean으로 축약하면
  // 정상 기업을 과대 배제하므로 text_only residual에 남긴다.
  if (UNSUPPORTED_THRESHOLD_SIGNAL.test(text)) return null;
  const programs = CANONICAL_PRIOR_AWARD_PROGRAMS
    .filter((program) => program.aliases.some((alias) => alias.test(text)))
    .map((program) => program.key);
  if (!PRIOR_AWARD_SIGNAL.test(text) && !(programs.length > 0 && PROGRAM_HISTORY_SIGNAL.test(text))) return null;
  const within = parseWithin(text);
  if (INCUBATION_SIGNAL.test(text)) return {
    scope: "self",
    self_kind: "same_year_other_support",
    channel: "incubation_tenancy",
    labels: [text],
  };

  const namedPrograms = programs.length > 0 ? programs : extractNamedPrograms(text);
  if (namedPrograms.length > 0) {
    const programType = programs.length > 0 && namedPrograms.every((key) =>
      CANONICAL_PRIOR_AWARD_PROGRAMS.some((program) => program.key === key && program.isProgramType));
    const states = inferStates(text);
    return {
      scope: programType ? "program_type" : "program",
      programs: namedPrograms,
      ...(states.length > 0 ? { states } : {}),
      ...(within ? { within } : {}),
      labels: [text],
    };
  }

  return {
    scope: "self",
    self_kind: inferSelfKind(text),
    channel: "general",
    ...(within ? { within } : {}),
    labels: [text],
  };
}

const PRIOR_AWARD_SIGNAL =
  /중복\s*(?:입주|지원|수혜|선정|참여)|동일\s*(?:한\s*)?(?:사업|과제)|동일\s*또는\s*유사(?:한)?\s*(?:사업|지원|내용)|본\s*사업과\s*동일(?:한)?\s*(?:지원|내용)|유사\s*(?:사업|지원)|타\s*부처|당해\s*연도|올해.{0,12}(?:지원|보조금)|과거.{0,12}본\s*사업|수료|사관학교|start[\s-]*up\s*nest|스타트업\s*네스트/i;
const INCUBATION_SIGNAL = /중복\s*입주|복수\s*공간.{0,12}입주|(?:창업)?보육센터|\bBI\b.{0,12}입주/i;
const PROGRAM_HISTORY_SIGNAL = /참여|수료|졸업|선정|수혜|기\s*수혜|중복|지원\s*(?:받|이력)/;
const PRIOR_AWARD_HEADING_ONLY = /^(?:중복\s*참여\s*제한|중복\s*지원\s*제한|신청\s*불가|지원\s*제외)$/;
const PRIOR_AWARD_PROCEDURAL_NOTICE = /^※.*(?:선정\s*취소|지원금.{0,20}환수|전액\s*환수)/;
const PRIOR_AWARD_CLAUSE_BOUNDARY =
  /(?=(?:중복\s*참여\s*제한|당해\s*연도|금년도|최근\s*\d{1,2}\s*(?:년|개월)|본\s*사업과|정부\s*\/\s*지자체\s*\/\s*유관기관으로부터\s*본\s*사업|동일\s*또는\s*유사|과거\s*본|아래\s*프로그램|[‘'“"]\s*\d{4}년|신청서\s*및|신청서·|사업계획서·지원서|사행성|본인이\s*직접|결격\s*사유|운영\s*적합|성년후견|기타\s*자체|※))/;
const UNSUPPORTED_THRESHOLD_SIGNAL =
  /(?:\d+(?:\.\d+)?\s*(?:천|만|억)+\s*원|지원금.{0,20}(?:초과|이상|미만|이하)|(?:총|최대)\s*\d+\s*개\s*과제|과제\s*수.{0,12}(?:미만|이하|초과|이상))/;

function extractNamedPrograms(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(/[『「‘'“"]([^』」’'”"]{3,80})[』」’'”"]/g)) {
    const label = match[1]?.replace(/^\d{4}년\s*/, "").trim();
    if (!label || /(?:법|자격|기준|조례|시행령)$/.test(label)) continue;
    const closingIndex = (match.index ?? 0) + match[0].length;
    // 인용부호가 법령명·표제일 수도 있으므로 바로 뒤 짧은 문맥에 이력 동사가 있는 명칭만 사업으로 본다.
    if (!PROGRAM_HISTORY_SIGNAL.test(text.slice(closingIndex, closingIndex + 100))) continue;
    result.push(label);
  }
  return [...new Set(result)].slice(0, 5);
}

function inferSelfKind(text: string): PriorAwardSelfKind {
  if (/과거.{0,16}본\s*사업|본\s*사업.{0,24}(?:입상|선정|수혜|동일(?:한)?\s*지원|지원금\s*받)/.test(text)) {
    return "same_business_prior";
  }
  if (/동일\s*(?:한\s*)?과제|협약\s*기간.{0,12}중복/.test(text)) return "same_project";
  if (/당해\s*연도|올해|타\s*부처|공공기관.{0,12}(?:중복|유사).{0,8}(?:지원|보조금)/.test(text)) {
    return "same_year_other_support";
  }
  return "current_similar";
}

function inferStates(text: string): PriorAwardState[] {
  const result: PriorAwardState[] = [];
  if (/참여\s*중|수행\s*중|협약\s*중/.test(text)) result.push("participating");
  if (/수료|졸업/.test(text)) result.push("graduated");
  if (/(?:선정|수혜|지원)\s*(?:받은|완료|이력)|기\s*수혜/.test(text)) result.push("completed");
  return [...new Set(result)];
}

function parseWithin(text: string): { value: number; unit: "year" | "month" } | null {
  const match = text.match(/최근\s*(\d{1,2})\s*(년|개월)/);
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  return { value, unit: match[2] === "년" ? "year" : "month" };
}

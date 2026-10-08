import { KSIC_DIVISIONS, KSIC_SECTIONS, resolveKsic } from "./ksic.js";

/**
 * Positive membership in policy industry categories. A broad company label does
 * not prove a narrower activity; an unknown label does not prove non-membership.
 * Software publishing, programming and hosting belong to ICT in the OECD ICT
 * definition: https://doi.org/10.1787/b9576889-en (2025).
 * These are policy concepts, not a replacement for an explicitly required KSIC.
 */
type IndustryCategory =
  | "ict" | "software" | "software_publishing" | "programming" | "game_software"
  | "application_software" | "system_software" | "hosting";

const PARENTS: Record<IndustryCategory, readonly IndustryCategory[]> = {
  ict: [],
  software: ["ict"],
  software_publishing: ["software"],
  programming: ["software"],
  game_software: ["software_publishing"],
  application_software: ["software_publishing"],
  system_software: ["software_publishing"],
  hosting: ["ict"],
};

const LABELS: Record<IndustryCategory, string> = {
  ict: "ICT",
  software: "소프트웨어",
  software_publishing: "소프트웨어 개발 및 공급업",
  programming: "컴퓨터 프로그래밍",
  game_software: "게임 소프트웨어",
  application_software: "응용 소프트웨어",
  system_software: "시스템 소프트웨어",
  hosting: "호스팅",
};

const ALIASES: Record<IndustryCategory, readonly string[]> = {
  ict: ["ICT", "IT", "정보통신", "정보통신기술", "정보기술"],
  software: ["SW", "S/W", "소프트웨어", "소프트웨어 개발업"],
  software_publishing: ["소프트웨어 개발 및 공급업"],
  application_software: ["응용 소프트웨어", "응용 소프트웨어 개발 및 공급업", "응용 소프트웨어 개발업"],
  system_software: ["시스템 소프트웨어", "시스템 소프트웨어 개발 및 공급업", "시스템 소프트웨어 개발업"],
  programming: ["컴퓨터 프로그래밍", "컴퓨터 프로그래밍 서비스업", "컴퓨터 프로그래밍 서비스"],
  game_software: ["게임 소프트웨어", "게임 소프트웨어 개발 및 공급업", "게임 소프트웨어 개발업"],
  hosting: ["호스팅", "호스팅 및 관련 서비스업", "자료 처리, 호스팅 및 관련 서비스업"],
};

function key(value: string): string {
  return value.toLowerCase().replace(/[\s·ㆍ_\-/]/g, "").replace(/(?:분야|기업|산업)$/u, "");
}

/** Policy concepts and statutory industry groups stay distinct. A code is never
 * invented from a business description. This registry reuses the existing KSIC
 * section/division catalogue and only follows child -> parent membership. */
export const INDUSTRY_CATEGORY_VERSION = "industry-category-v2";
const nodes = new Map<string, { label: string; parents: readonly string[] }>(
  Object.entries(LABELS).map(([id, label]) => [id, { label, parents: PARENTS[id as IndustryCategory] }]),
);
const CATEGORY_BY_ALIAS = new Map<string, string>(Object.entries(ALIASES).flatMap(([id, aliases]) =>
  aliases.map((alias) => [key(alias), id] as const)));
for (const section of KSIC_SECTIONS) {
  nodes.set(`ksic:${section.code}`, { label: section.label, parents: [] });
  CATEGORY_BY_ALIAS.set(key(section.label), `ksic:${section.code}`);
}
for (const division of KSIC_DIVISIONS) {
  nodes.set(`ksic:${division.code}`, { label: division.label, parents: [`ksic:${division.section}`] });
  CATEGORY_BY_ALIAS.set(key(division.label), `ksic:${division.code}`);
}
// Exact activity aliases only. Products, technologies, customers and the fact that
// a company uses AI/software do not establish a registered industry membership.
const statutoryAliases: Record<string, readonly string[]> = {
  "10": ["식품제조", "식품 제조업", "식료품제조"],
  "32": ["가구제조업"],
  "59": ["영상·오디오 기록물 제작 및 배급업"],
  "62": ["컴퓨터 프로그래밍·시스템 통합 및 관리업"],
  "70": ["연구개발", "연구개발업"],
  "71": ["전문서비스업"],
  "G": ["도소매업", "도·소매업", "도매 및 소매"],
};
for (const [code, aliases] of Object.entries(statutoryAliases)) {
  for (const alias of aliases) CATEGORY_BY_ALIAS.set(key(alias), `ksic:${code}`);
}
// A narrower everyday activity is a child node, not an alias of an entire
// statistical division (e.g. transport support is not necessarily warehousing).
for (const [id, label, parent, aliases] of [
  ["clothing_manufacturing", "의류 제조", "ksic:14", ["의류제조", "의류 제조업", "의복 제조업"]],
  ["warehousing", "창고업", "ksic:52", ["창고업"]],
  ["retail", "소매업", "ksic:G", ["소매업"]],
] as const) {
  nodes.set(id, { label, parents: [parent] });
  for (const alias of aliases) CATEGORY_BY_ALIAS.set(key(alias), id);
}
nodes.set("ksic:47", { ...nodes.get("ksic:47")!, parents: ["retail"] });

// Links for exact activities already recognized by the policy dictionary.
for (const [id, parents] of Object.entries({
  software: ["ict", "ksic:J"], software_publishing: ["software", "ksic:58"],
  programming: ["software", "ksic:62"], hosting: ["ict", "ksic:63"],
})) nodes.set(id, { ...nodes.get(id)!, parents });

function category(value: string): string | undefined {
  return CATEGORY_BY_ALIAS.get(key(value));
}

function membershipPath(actual: string, target: string, visited = new Set<string>()): string[] | null {
  if (actual === target) return [actual];
  if (visited.has(actual)) return null;
  const next = new Set(visited).add(actual);
  for (const parent of nodes.get(actual)?.parents ?? []) {
    const path = membershipPath(parent, target, next);
    if (path) return [actual, ...path];
  }
  return null;
}

function codeCategory(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  // Do not interpret six-digit tax codes or contradictory section prefixes as KSIC.
  if (!/^(?:[A-U]|[A-U]?\d{2,5})$/u.test(normalized)) return;
  const resolved = resolveKsic(normalized);
  if (/^[A-U]\d/u.test(normalized) && resolved.section?.code !== normalized[0]) return;
  return resolved.division ? `ksic:${resolved.division.code}`
    : resolved.section ? `ksic:${resolved.section.code}` : undefined;
}

export interface IndustryCategoryComparison {
  /** At least one policy category was recognized; a miss is not exhaustive. */
  recognized: boolean;
  match: { required: string; observed: string; path: string[] } | null;
}

export function compareIndustryCategories(
  requiredLabels: readonly string[],
  companyLabels: readonly string[],
  companyCodes: readonly string[] = [],
): IndustryCategoryComparison {
  let recognized = false;
  const observations = [
    ...companyLabels.map(observed => ({ observed, actual: category(observed) })),
    ...companyCodes.map(code => ({ observed: `KSIC ${code}`, actual: codeCategory(code) })),
  ];
  for (const required of requiredLabels) {
    const target = category(required);
    if (!target) continue;
    recognized = true;
    for (const { observed, actual } of observations) {
      if (!actual) continue;
      const path = membershipPath(actual, target);
      if (path) return { recognized, match: { required, observed, path: path.map(id => nodes.get(id)!.label) } };
    }
  }
  return { recognized, match: null };
}

/** Prevent substring matching from reversing or flattening a known hierarchy. */
export function involvesIndustryCategory(left: string, right: string): boolean {
  return Boolean(category(left) || category(right));
}

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

const CATEGORY_BY_ALIAS = new Map(Object.entries(ALIASES).flatMap(([category, aliases]) =>
  aliases.map((alias) => [key(alias), category as IndustryCategory] as const)));

function category(value: string): IndustryCategory | undefined {
  return CATEGORY_BY_ALIAS.get(key(value));
}

function ancestry(value: IndustryCategory): IndustryCategory[] {
  return [value, ...PARENTS[value].flatMap(ancestry)];
}

export interface IndustryCategoryComparison {
  /** At least one policy category was recognized; a miss is not exhaustive. */
  recognized: boolean;
  match: { required: string; observed: string; path: string[] } | null;
}

export function compareIndustryCategories(
  requiredLabels: readonly string[],
  companyLabels: readonly string[],
): IndustryCategoryComparison {
  let recognized = false;
  for (const required of requiredLabels) {
    const target = category(required);
    if (!target) continue;
    recognized = true;
    for (const observed of companyLabels) {
      const actual = category(observed);
      if (!actual) continue;
      const path = ancestry(actual);
      const index = path.indexOf(target);
      if (index >= 0) return { recognized, match: { required, observed, path: path.slice(0, index + 1).map((id) => LABELS[id]) } };
    }
  }
  return { recognized, match: null };
}

/** Prevent substring matching from reversing or flattening a known hierarchy. */
export function involvesIndustryCategory(left: string, right: string): boolean {
  return Boolean(category(left) || category(right));
}

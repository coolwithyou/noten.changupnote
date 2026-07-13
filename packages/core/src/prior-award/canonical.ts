export interface CanonicalPriorAwardProgram {
  key: string;
  label: string;
  isProgramType: boolean;
  aliases: RegExp[];
}

export const CANONICAL_PRIOR_AWARD_PROGRAMS: readonly CanonicalPriorAwardProgram[] = [
  program("chogi_startup_package", "초기창업패키지", [/초기\s*창업\s*패키지/i]),
  program("pre_startup_package", "예비창업패키지", [/예비\s*창업\s*패키지/i]),
  program("startup_leap_package", "창업도약패키지", [/창업\s*도약\s*패키지/i]),
  program("startup_academy", "창업사관학교", [/(?:청년|글로벌|딥테크)?\s*창업\s*사관학교/i], true),
  program("startup_nest", "Start-up NEST", [/(?:start[\s-]*up\s*)?nest(?:\s*space)?/i, /스타트업\s*네스트/i], true),
  program("makerspace", "메이커스페이스", [/메이커\s*스페이스/i]),
  program("local_creator", "로컬크리에이터", [/로컬\s*크리에이터/i]),
  program("social_venture", "소셜벤처", [/소셜\s*벤처/i]),
  program("tips", "TIPS", [/(?:딥테크\s*)?tips/i, /팁스/i]),
] as const;

export const PRIOR_AWARD_PROGRAM_QUESTION_COVERAGE: Readonly<Record<string, readonly string[]>> = {
  named_program_history: CANONICAL_PRIOR_AWARD_PROGRAMS.filter((item) => !item.isProgramType).map((item) => item.key),
  program_type_history: CANONICAL_PRIOR_AWARD_PROGRAMS.filter((item) => item.isProgramType).map((item) => item.key),
};

export function normalizePriorAwardProgramLabel(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const keyMatch = CANONICAL_PRIOR_AWARD_PROGRAMS.find((item) => item.key === text);
  if (keyMatch) return keyMatch.key;
  return CANONICAL_PRIOR_AWARD_PROGRAMS.find((item) => item.aliases.some((alias) => alias.test(text)))?.key ?? null;
}

export function priorAwardProgramLabel(key: string): string {
  return CANONICAL_PRIOR_AWARD_PROGRAMS.find((item) => item.key === key)?.label ?? key;
}

export function isPriorAwardProgramType(key: string): boolean {
  return CANONICAL_PRIOR_AWARD_PROGRAMS.some((item) => item.key === key && item.isProgramType);
}

function program(key: string, label: string, aliases: RegExp[], isProgramType = false): CanonicalPriorAwardProgram {
  return { key, label, aliases, isProgramType };
}

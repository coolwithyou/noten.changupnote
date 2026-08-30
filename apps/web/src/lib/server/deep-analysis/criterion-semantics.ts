function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (
    typeof item === "string" && item.trim().length > 0
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CERTIFICATION_ALTERNATIVE_PATTERN =
  /(?:또는|혹은|이거나|택\s*1|중\s*(?:하나|1개)|어느\s*하나)/u;
const NESTED_CERTIFICATION_REQUIREMENT_PATTERN =
  /(?:지정|인증|확인|선정)(?:된|받은)?[^.!?\n]{0,100}\s중\s[^.!?\n]{0,100}(?:지정|인증|확인|선정)(?:을|를)?\s*(?:받은|보유한|획득한|충족한)/u;
const EXPLICIT_COMPOUND_CERTIFICATION_PATTERN =
  /(?:모두|동시에|둘\s*다|겸비|동시\s*보유)/u;

/**
 * certification/in의 certs 배열은 matcher에서 OR 멤버십으로 해석된다. 원문이
 * 상위 지정 집합 안에서 추가 지정을 요구하거나 복수 자격의 동시 충족을 명시하면
 * 배열로 분해하지 않고 text_only로 보존해야 한다.
 */
export function isConjunctiveCertificationMembership(input: {
  operator: string;
  value: unknown;
  sourceSpan: string | null;
}): boolean {
  if (input.operator !== "in" || !input.sourceSpan || !isRecord(input.value)) return false;
  if (stringArray(input.value.certs).length < 2) return false;
  const sourceSpan = input.sourceSpan.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (CERTIFICATION_ALTERNATIVE_PATTERN.test(sourceSpan)) return false;
  return NESTED_CERTIFICATION_REQUIREMENT_PATTERN.test(sourceSpan)
    || EXPLICIT_COMPOUND_CERTIFICATION_PATTERN.test(sourceSpan);
}

const PRIOR_AWARD_ACTOR_CONTINUITY_PATTERN =
  /(?:해당|당시|종전|기존)\s*(?:지원)?\s*과제(?:의)?\s*(?:연구개발)?책임자.{0,40}(?:신청|참여|수행)/u;
const PRIOR_AWARD_RELATIONAL_SCOPE_PATTERN =
  /(?:본|해당|신청)\s*과제와\s*(?:동일|유사)(?:한)?\s*(?:분야|기술|품목|주제)/u;

/**
 * prior_award의 programs/states/within은 사업 이력만 표현한다. 원문이 당시
 * 책임자의 연속 참여나 현재 과제와의 분야·기술 유사성까지 요구하면 이 구조값만으로
 * 자동 매칭할 수 없으므로 전체 조건을 text_only로 보존해야 한다.
 */
export function isLossyStructuredPriorAward(input: {
  operator: string;
  value: unknown;
  sourceSpan: string | null;
}): boolean {
  if (input.operator === "text_only" || !input.sourceSpan || !isRecord(input.value)) {
    return false;
  }
  const sourceSpan = input.sourceSpan.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (PRIOR_AWARD_ACTOR_CONTINUITY_PATTERN.test(sourceSpan)) return true;
  const scope = typeof input.value.scope === "string" ? input.value.scope : null;
  const hasProgramScope = scope === "program"
    || scope === "program_type"
    || stringArray(input.value.programs).length > 0;
  return hasProgramScope && PRIOR_AWARD_RELATIONAL_SCOPE_PATTERN.test(sourceSpan);
}

export type TargetTypeListSemanticsDecision =
  | "open"
  | "closed"
  | "unresolved"
  | "unchanged";

export type TargetTypeListSemanticsReason =
  | "not_applicable"
  | "insufficient_grounding"
  | "kstartup_summary_metadata"
  | "bizinfo_summary_metadata"
  | "delegated_summary"
  | "explicit_closed_marker"
  | "explicit_open_marker"
  | "generic_applicant_description"
  | "finite_eligibility_list";

export interface TargetTypeListSemanticsResolution {
  decision: TargetTypeListSemanticsDecision;
  reason: TargetTypeListSemanticsReason;
  sourceKind: "kstartup_summary" | "bizinfo_summary" | "detailed_or_unknown";
  previousClaim: "open" | "closed" | null;
}

/**
 * target_type 목록 의미를 extractor와 validator가 같은 규칙으로 판단한다. 포털 요약,
 * 검증된 인용의 명시적 제한/예시, 현재 구조 주장을 함께 보되 일반 명사만으로는
 * open/closed를 확정하지 않는다.
 */
export function resolveTargetTypeListSemantics(input: {
  dimension: string;
  kind: string;
  operator: string;
  sourceSpan: string | null;
  spanVerified: boolean;
  targets: string[];
  listSemantics: unknown;
  note: string | null;
  inputText: string;
}): TargetTypeListSemanticsResolution {
  const previousClaim = input.listSemantics === "open" || input.listSemantics === "closed"
    ? input.listSemantics
    : null;
  if (
    input.dimension !== "target_type"
    || input.kind !== "required"
    || input.operator !== "in"
  ) {
    return { decision: "unchanged", reason: "not_applicable", sourceKind: "detailed_or_unknown", previousClaim };
  }
  if (!input.spanVerified || !input.sourceSpan || input.targets.length === 0) {
    return { decision: "unchanged", reason: "insufficient_grounding", sourceKind: "detailed_or_unknown", previousClaim };
  }
  const sourceSpan = normalizeEvidence(input.sourceSpan);
  if (!input.targets.every((target) => sourceSpan.includes(normalizeEvidence(target)))) {
    return { decision: "unchanged", reason: "insufficient_grounding", sourceKind: "detailed_or_unknown", previousClaim };
  }
  if (hasStructuredSummaryEvidence({
    sourceSpan,
    inputText: input.inputText,
    label: "신청대상 요약",
    sourceField: "aply_trgt",
  })) {
    return { decision: "open", reason: "kstartup_summary_metadata", sourceKind: "kstartup_summary", previousClaim };
  }
  if (hasStructuredSummaryEvidence({
    sourceSpan,
    inputText: input.inputText,
    label: "지원대상",
    sourceField: "trgetNm",
  })) {
    return { decision: "open", reason: "bizinfo_summary_metadata", sourceKind: "bizinfo_summary", previousClaim };
  }
  if (hasDelegatedOpenTargetTypeEvidence({
    sourceSpan,
    note: input.note,
    inputText: input.inputText,
  })) {
    return { decision: "open", reason: "delegated_summary", sourceKind: "detailed_or_unknown", previousClaim };
  }
  if (hasExplicitClosedTargetTypeListMarker(sourceSpan)) {
    return { decision: "closed", reason: "explicit_closed_marker", sourceKind: "detailed_or_unknown", previousClaim };
  }
  if (hasOpenTargetTypeListMarker(sourceSpan)) {
    return { decision: "open", reason: "explicit_open_marker", sourceKind: "detailed_or_unknown", previousClaim };
  }
  if (input.targets.every(isGenericApplicantDescription)) {
    return { decision: "unresolved", reason: "generic_applicant_description", sourceKind: "detailed_or_unknown", previousClaim };
  }
  return { decision: "closed", reason: "finite_eligibility_list", sourceKind: "detailed_or_unknown", previousClaim };
}

function hasStructuredSummaryEvidence(input: {
  sourceSpan: string;
  inputText: string;
  label: string;
  sourceField: string;
}): boolean {
  const lines = input.inputText.split(/\r?\n/u);
  const escapedLabel = escapeRegExp(input.label);
  const escapedField = escapeRegExp(input.sourceField);
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeEvidence(lines[index] ?? "");
    const short = new RegExp(
      `^${escapedLabel}:\\s*(.*?)\\s*\\(source_field:\\s*${escapedField}\\)$`,
      "u",
    ).exec(line)?.[1];
    if (
      short
      && (
        normalizeEvidence(short) === input.sourceSpan
        || normalizeEvidence(`${input.label}: ${short}`) === input.sourceSpan
      )
    ) return true;
    if (line !== `## ${input.label}`) continue;
    if (normalizeEvidence(lines[index + 1] ?? "") !== `source_field: ${input.sourceField}`) continue;
    const body: string[] = [];
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      if (/^##\s/u.test(candidate) || /^\[블록:/u.test(candidate)) break;
      body.push(candidate);
    }
    if (normalizeEvidence(body.join("\n")).includes(input.sourceSpan)) return true;
  }
  return false;
}

function hasDelegatedOpenTargetTypeEvidence(input: {
  sourceSpan: string;
  note: string | null;
  inputText: string;
}): boolean {
  if (!/신청대상\s*요약/u.test(input.sourceSpan)) return false;
  if (
    !input.note
    || !/(?:open|열린|개방형|완전열거가\s*아닌)/iu.test(input.note)
    || !/목록/u.test(input.note)
  ) return false;
  return /신청대상\s*상세\s*:\s*각\s*지원사업\s*모집\s*공고문\s*참고/u
    .test(normalizeEvidence(input.inputText));
}

function hasExplicitClosedTargetTypeListMarker(sourceSpan: string): boolean {
  return /(?:다음\s*각\s*호|아래\s*(?:유형|대상)|열거한\s*(?:유형|대상)).{0,20}(?:에\s*한함|만)/u.test(sourceSpan)
    || /(?:유형|대상).{0,16}(?:에\s*한함|으로\s*한정)/u.test(sourceSpan)
    || /(?:이외|그\s*외|외의?).{0,16}(?:신청|참여)\s*(?:불가|제외)/u.test(sourceSpan)
    || /(?:만|에\s*한해)\s*(?:신청|참여)할?\s*수\s*있/u.test(sourceSpan);
}

function hasOpenTargetTypeListMarker(sourceSpan: string): boolean {
  return /(?:^|[\s,·/])등(?:은|는|이|가|을|를|의|과|도|으로)?(?:$|[\s,.)])/u.test(sourceSpan)
    || /예\s*:|예시|예컨대|일례/u.test(sourceSpan)
    || /포함하되\s*이에\s*한정되지/u.test(sourceSpan)
    || /포함(?:한|하는|하며|하고)/u.test(sourceSpan)
    || /(?:주로|대표적으로|중심으로)/u.test(sourceSpan);
}

function isGenericApplicantDescription(target: string): boolean {
  return /^(?:업체|농가|사업체)$/u.test(normalizeEvidence(target));
}

function normalizeEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

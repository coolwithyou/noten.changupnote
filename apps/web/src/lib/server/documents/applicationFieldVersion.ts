// v8은 표 밖 단일 문단 입력의 prefix/value/suffix와 occurrence를 exact binding까지 보존한다.
export const APPLICATION_FIELD_PARSER_VERSION = "kordoc-rhwp-application-fields-v8";
export const APPLICATION_FIELD_PARSER_PREFIX = "kordoc-rhwp-application-fields-";

export function isAutomatedApplicationFieldParserVersion(value: string): boolean {
  return value.startsWith(APPLICATION_FIELD_PARSER_PREFIX);
}

export function isCurrentApplicationFieldParserVersion(value: string): boolean {
  return value === APPLICATION_FIELD_PARSER_VERSION;
}

export type ApplicationFieldMapState = "empty" | "current_automated" | "stale_automated" | "protected";

/** 사람 검수 필드와 자동 필드를 섞어 덮어쓰지 않도록 재분석 가능 범위를 한 곳에서 판정한다. */
export function classifyApplicationFieldMap(parserVersions: readonly string[]): ApplicationFieldMapState {
  if (parserVersions.length === 0) return "empty";
  const automated = parserVersions.filter(isAutomatedApplicationFieldParserVersion);
  if (automated.length !== parserVersions.length) return "protected";
  return automated.every(isCurrentApplicationFieldParserVersion) ? "current_automated" : "stale_automated";
}

/**
 * field-agent 감사 이력이 field ID를 참조하므로 자동 파서 업그레이드는 기존 key를 삭제할 수 없다.
 * 기존 key를 모두 보존하는 additive revision만 제자리 갱신하고, 제거·이름변경 revision은 별도
 * migration 없이는 fail-closed한다.
 */
export function isAdditiveApplicationFieldMapUpgrade(
  existingFieldKeys: readonly string[],
  nextFieldKeys: readonly string[],
): boolean {
  const next = new Set(nextFieldKeys);
  return existingFieldKeys.every((fieldKey) => next.has(fieldKey));
}

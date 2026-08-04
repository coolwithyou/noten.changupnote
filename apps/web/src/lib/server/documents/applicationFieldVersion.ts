export const APPLICATION_FIELD_PARSER_VERSION = "kordoc-rhwp-application-fields-v2";
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

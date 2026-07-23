export interface RhwpCellCharProperties {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  textColor?: string;
}

const GUIDE_TEXT_PATTERN = /(?:기재\s*(?:시|란|요령|바랍니다|하세요)?|작성\s*(?:예시|요령|내용|란)?|입력\s*(?:예시|란|하세요)?|서술\s*(?:예시|하세요)?|제시|선택\s*기입|해당\s*시|예시|sample)|^[※*]/iu;
const STRONG_GUIDE_PATTERN = /(?:기재\s*시|선택\s*기입|작성\s*예시|입력\s*예시|^[※*])/iu;

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
}

export function parseRhwpCellCharProperties(value: string | null | undefined): RhwpCellCharProperties | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as RhwpCellCharProperties : null;
  } catch {
    return null;
  }
}

function isGuideStyle(properties: RhwpCellCharProperties | null): boolean {
  if (!properties) return false;
  const color = properties.textColor?.toLocaleLowerCase("en-US");
  return properties.italic === true || Boolean(color && color !== "#000000" && color !== "#111111");
}

/** 실제 값과 혼동하지 않도록 텍스트 의미와 원문/문자 모양 중 하나가 함께 확인된 안내문만 교체한다. */
export function isReplaceableRhwpGuide(
  value: string,
  sourceSpan: string | null | undefined,
  properties: RhwpCellCharProperties | null,
): boolean {
  const normalized = normalizedText(value);
  if (!normalized || !GUIDE_TEXT_PATTERN.test(value)) return false;
  const sourceConfirmed = Boolean(sourceSpan && normalizedText(sourceSpan).includes(normalized));
  return sourceConfirmed || isGuideStyle(properties) || STRONG_GUIDE_PATTERN.test(value);
}

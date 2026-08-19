/** HWP/HWPX 원문에 표시된 체크박스/라디오 선택지를 결정적으로 추출·변경한다. */

const CHECK_GLYPH = /[□☐☑■]/u;
const CHECK_GLYPH_GLOBAL = /[□☐☑■]/gu;
const CHOICE_TYPE = /(checkbox|radio|select|choice)/iu;

export interface FieldChoiceOption {
  value: string;
  marker: "□" | "☐" | "☑" | "■";
  markerOffset: number;
}

function cleanOption(raw: string): string {
  return raw
    .replace(/^[\s:：·,;/|-]+|[\s:：·,;/|-]+$/g, "")
    .replace(/\(\s*\)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(cleanOption).filter((value) => value.length > 0 && value.length <= 80))];
}

export function extractFieldOptions(fieldType: string, sourceSpan: string | null): string[] {
  if (!sourceSpan) return [];
  const source = sourceSpan.normalize("NFKC");

  if (CHECK_GLYPH.test(source)) {
    const options = parseChoiceCellOptions(source).map((option) => option.value);
    // parser가 field_type=text로 저장했더라도 실제 원문에 선택 마커가 두 개 이상이면
    // 구조화 선택지로 승격한다. 보기 하나뿐인 표기는 선택 계약을 만들 수 없으므로 제외한다.
    return options.length >= 2 ? options : [];
  }

  if (!CHOICE_TYPE.test(fieldType)) return [];
  // 동의( ) 미동의( )처럼 체크 glyph 대신 빈 괄호를 쓰는 국내 서식.
  const matches = [...source.matchAll(/([가-힣A-Za-z0-9][가-힣A-Za-z0-9·/+\- ]{0,30}?)\s*\(\s*\)/g)]
    .map((match) => {
      const words = (match[1] ?? "").trim().split(/\s+/);
      return words.at(-1) ?? "";
    });
  return unique(matches);
}

/** 셀 텍스트를 훼손하지 않고 각 marker와 바로 뒤 option label만 구조화한다. */
export function parseChoiceCellOptions(source: string): FieldChoiceOption[] {
  const matches = [...source.matchAll(CHECK_GLYPH_GLOBAL)];
  const options: FieldChoiceOption[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const markerOffset = Array.from(source.slice(0, match.index)).length;
    const nextOffset = matches[index + 1]?.index ?? source.length;
    const raw = source.slice(match.index + match[0].length, nextOffset);
    // 표의 다음 라벨이나 줄 설명이 함께 잡힌 경우 선택지의 첫 줄만 사용한다.
    const firstLine = raw.split(/\r?\n/u)[0] ?? "";
    const value = cleanOption(firstLine.replace(/\s*\*.*$/u, "").normalize("NFKC"));
    if (!value || value.length > 80) continue;
    options.push({
      value,
      marker: match[0] as FieldChoiceOption["marker"],
      markerOffset,
    });
  }
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.value, (counts.get(option.value) ?? 0) + 1);
  return options.filter((option) => counts.get(option.value) === 1);
}

/**
 * exact option을 하나 선택한 셀 postimage를 만든다. option 문구와 공백은 그대로 두고 marker 한 글자만
 * 바꾼다. 선택지가 아니면 null, 선택지인데 허용값이 아니면 예외로 fail-closed한다.
 */
export function buildChoiceCellReplacement(source: string, selectedValue: string): string | null {
  const options = parseChoiceCellOptions(source);
  if (options.length < 2) return null;
  const selected = cleanOption(selectedValue.normalize("NFKC"));
  const matches = options.filter((option) => option.value === selected);
  if (matches.length !== 1) {
    throw new Error("선택값이 현재 문서의 exact 선택지와 일치하지 않습니다.");
  }
  const checkedMarker = options.some((option) => option.marker === "☑")
    ? "☑"
    : options.some((option) => option.marker === "■")
      ? "■"
      : options.some((option) => option.marker === "☐")
        ? "☑"
        : "■";
  const uncheckedMarker = options.some((option) => option.marker === "☐") ? "☐" : "□";
  const characters = Array.from(source);
  for (const option of options) {
    characters[option.markerOffset] = option.value === selected ? checkedMarker : uncheckedMarker;
  }
  return characters.join("");
}

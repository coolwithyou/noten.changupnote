/** HWP/HWPX 원문에 표시된 체크박스/라디오 선택지를 결정적으로 추출한다. */

const CHECK_GLYPH = /[□☐☑■]/;

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
  if (!sourceSpan || !/(checkbox|radio|select|choice)/i.test(fieldType)) return [];
  const source = sourceSpan.normalize("NFKC");

  if (CHECK_GLYPH.test(source)) {
    const chunks = source.split(CHECK_GLYPH).slice(1);
    return unique(chunks.map((chunk) => {
      // 표의 다음 라벨이나 줄 설명이 함께 잡힌 경우 선택지의 첫 줄만 사용한다.
      const firstLine = chunk.split(/\r?\n/)[0] ?? "";
      return firstLine.replace(/\s*\*.*$/u, "");
    }));
  }

  // 동의( ) 미동의( )처럼 체크 glyph 대신 빈 괄호를 쓰는 국내 서식.
  const matches = [...source.matchAll(/([가-힣A-Za-z0-9][가-힣A-Za-z0-9·/+\- ]{0,30}?)\s*\(\s*\)/g)]
    .map((match) => {
      const words = (match[1] ?? "").trim().split(/\s+/);
      return words.at(-1) ?? "";
    });
  return unique(matches);
}

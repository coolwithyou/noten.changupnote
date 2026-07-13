/**
 * 의존성 없는 CSV 파서(RFC4180 근사).
 *
 * 처리 범위: 따옴표로 감싼 필드 내부의 콤마·개행, 이스케이프된 `""`(→ 리터럴 `"`),
 * CRLF/LF 혼용, 완전 빈 줄 무시(후행 포함). 따옴표로 감싼 빈 필드(`""`)는 데이터로
 * 유지한다. 인코딩 디코딩(EUC-KR 등)은 범위 밖 — 이 파서는 이미 디코딩된 문자열을 받는다.
 */

/** CSV/TSV 텍스트 → 헤더 포함 전체 행렬(각 행은 필드 문자열 배열). */
export function parseCsv(text: string, opts?: { delimiter?: "," | "\t" }): string[][] {
  const delimiter = opts?.delimiter ?? ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let fieldStarted = false; // 현재 필드에 실제로 문자가 시작됐는지(빈 행 판별용)

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    // 후행 빈 줄(단일 빈 필드) 무시.
    if (!(row.length === 1 && row[0] === "" && !fieldStarted)) {
      rows.push(row);
    }
    row = [];
    fieldStarted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // 이스케이프된 따옴표("")인지 판별.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // 짝의 두 번째 따옴표 소비.
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    switch (ch) {
      case '"':
        inQuotes = true;
        fieldStarted = true;
        break;
      case ",":
      case "\t":
        if (ch === delimiter) {
          pushField();
          fieldStarted = false;
        } else {
          field += ch;
          fieldStarted = true;
        }
        break;
      case "\r":
        // CRLF 의 CR 은 무시하고 LF 에서 행을 종료한다. 단독 CR 은 다음 문자가 LF 가
        // 아니면 행 종료로 취급.
        if (text[i + 1] === "\n") {
          break; // LF 케이스로 위임.
        }
        pushRow();
        break;
      case "\n":
        pushRow();
        break;
      default:
        field += ch;
        fieldStarted = true;
        break;
    }
  }

  // 마지막 행이 개행 없이 끝난 경우 flush. 완전 빈 입력은 무시.
  if (field !== "" || row.length > 0 || fieldStarted) {
    pushRow();
  }

  return rows;
}

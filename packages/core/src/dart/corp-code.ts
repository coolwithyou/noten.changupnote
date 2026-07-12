/** OpenDART 고유번호 ZIP 내부 CORPCODE.xml 파서와 회사명 exact 후보 선택. */

export interface DartCorpCodeEntry {
  corpCode: string;
  corpName: string;
  corpEnglishName: string | null;
  stockCode: string | null;
  modifiedOn: string | null;
}

export function parseDartCorpCodes(xml: string): DartCorpCodeEntry[] {
  const entries: DartCorpCodeEntry[] = [];
  for (const match of xml.matchAll(/<list\b[^>]*>([\s\S]*?)<\/list>/gi)) {
    const block = match[1] ?? "";
    const corpCode = extractTag(block, "corp_code")?.replace(/\D/g, "") ?? "";
    const corpName = extractTag(block, "corp_name") ?? "";
    if (corpCode.length !== 8 || !corpName) continue;
    entries.push({
      corpCode,
      corpName,
      corpEnglishName: extractTag(block, "corp_eng_name"),
      stockCode: emptyToNull(extractTag(block, "stock_code")?.replace(/\D/g, "") ?? ""),
      modifiedOn: dateKeyOrNull(extractTag(block, "modify_date")),
    });
  }
  return entries;
}

export function findDartCorpCodeCandidates(
  entries: DartCorpCodeEntry[],
  companyName: string,
  limit = 10,
): DartCorpCodeEntry[] {
  const needle = normalizeDartCompanyName(companyName);
  if (!needle) return [];
  return entries
    .filter((entry) => normalizeDartCompanyName(entry.corpName) === needle)
    .sort((a, b) => Number(Boolean(b.stockCode)) - Number(Boolean(a.stockCode)))
    .slice(0, Math.max(1, limit));
}

export function normalizeDartCompanyName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|유한회사|유한책임회사/g, "")
    .replace(/[\s·.,()\[\]{}_-]+/g, "")
    .trim();
}

function extractTag(xml: string, tag: string): string | null {
  const raw = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
  if (raw === undefined) return null;
  const text = decodeXml(raw.replace(/<[^>]+>/g, "").trim());
  return text || null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function emptyToNull(value: string): string | null {
  return value || null;
}

function dateKeyOrNull(value: string | null): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length === 8 ? digits : null;
}

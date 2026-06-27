import type {
  BizInfoAttachmentMarkdown,
  BizInfoExtractionBlock,
  BizInfoProgram,
  BizInfoProgramExtractionInput,
} from "./types.js";

const BIZINFO_ORIGIN = "https://www.bizinfo.go.kr";

export function buildBizInfoProgramExtractionInput(
  program: BizInfoProgram,
  options: { attachmentMarkdowns?: BizInfoAttachmentMarkdown[] } = {},
): BizInfoProgramExtractionInput {
  const title = cleanText(program.pblancNm) || program.pblancId;
  const attachments = collectAttachments(program);
  const blocks: BizInfoExtractionBlock[] = [
    fieldBlock("공고명", "pblancNm", title),
    fieldBlock("지원대상", "trgetNm", program.trgetNm),
    fieldBlock("신청기간", "reqstBeginEndDe", program.reqstBeginEndDe),
    fieldBlock("지원분야", "pldirSportRealmLclasCodeNm", category(program)),
    fieldBlock("신청방법", "reqstMthPapersCn", htmlToText(program.reqstMthPapersCn)),
    fieldBlock("사업요약", "bsnsSumryCn", htmlToText(program.bsnsSumryCn)),
  ].filter((block) => block.text.length > 0);

  for (const attachment of options.attachmentMarkdowns ?? []) {
    const text = cleanText(attachment.markdown);
    if (!text) continue;
    blocks.push({
      label: `첨부 변환문서: ${attachment.filename}`,
      source: "attachment_markdown",
      filename: attachment.filename,
      text,
    });
  }

  return {
    source: "bizinfo",
    source_id: program.pblancId,
    title,
    url: normalizeBizInfoUrl(program.pblancUrl),
    metadata: {
      target: nullableText(program.trgetNm),
      jurisdiction_agency: nullableText(program.jrsdInsttNm),
      operating_agency: nullableText(program.excInsttNm),
      category_l1: nullableText(program.pldirSportRealmLclasCodeNm),
      category_l2: nullableText(program.pldirSportRealmMlsfcCodeNm),
      apply_period: nullableText(program.reqstBeginEndDe),
      application_method: nullableText(htmlToText(program.reqstMthPapersCn)),
      hashtags: splitTags(program.hashtags),
      attachments,
    },
    blocks,
    text: renderBlocks(program.pblancId, title, blocks),
  };
}

export function htmlToText(value: string | null | undefined): string {
  if (!value) return "";
  return decodeHtmlEntities(value.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " "))
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*(li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeBizInfoUrl(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("/")) return `${BIZINFO_ORIGIN}${text}`;
  return text;
}

function collectAttachments(program: BizInfoProgram): Array<{ filename: string; url: string | null }> {
  const names = splitMaybeMultiValue(program.fileNm);
  const printNames = splitMaybeMultiValue(program.printFileNm);
  const fileUrls = splitMaybeMultiValue(program.flpthNm);
  const printUrls = splitMaybeMultiValue(program.printFlpthNm);
  const max = Math.max(names.length, printNames.length, fileUrls.length, printUrls.length);
  const attachments: Array<{ filename: string; url: string | null }> = [];

  for (let index = 0; index < max; index += 1) {
    const filename = names[index] ?? printNames[index];
    if (!filename) continue;
    attachments.push({
      filename,
      url: normalizeBizInfoUrl(fileUrls[index] ?? printUrls[index]),
    });
  }

  return attachments;
}

function renderBlocks(sourceId: string, title: string, blocks: BizInfoExtractionBlock[]): string {
  const header = [
    "[기업마당 지원사업 추출 입력]",
    `source_id: ${sourceId}`,
    `title: ${title}`,
  ].join("\n");
  return [
    header,
    ...blocks.map((block) => [
      `\n## ${block.label}`,
      block.source_field ? `source_field: ${String(block.source_field)}` : undefined,
      block.filename ? `filename: ${block.filename}` : undefined,
      block.text,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function fieldBlock(
  label: string,
  sourceField: keyof BizInfoProgram,
  value: string | null | undefined,
): BizInfoExtractionBlock {
  return {
    label,
    source: "api_field",
    source_field: sourceField,
    text: cleanText(value),
  };
}

function category(program: BizInfoProgram): string {
  return [program.pldirSportRealmLclasCodeNm, program.pldirSportRealmMlsfcCodeNm]
    .map(nullableText)
    .filter(Boolean)
    .join(" > ");
}

function splitTags(value: string | null | undefined): string[] {
  return splitMaybeMultiValue(value).map((tag) => tag.trim()).filter(Boolean);
}

function splitMaybeMultiValue(value: string | null | undefined): string[] {
  return cleanText(value)
    .split(/\s*(?:,|\r?\n|\||@)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function nullableText(value: string | null | undefined): string | null {
  const text = cleanText(value);
  return text || null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

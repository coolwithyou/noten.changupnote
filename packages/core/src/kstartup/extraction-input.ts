import type {
  KStartupAnnouncement,
  KStartupAttachmentMarkdown,
  KStartupExtractionBlock,
  KStartupExtractionInput,
} from "./types.js";

export function buildKStartupExtractionInput(
  announcement: KStartupAnnouncement,
  options: { attachmentMarkdowns?: KStartupAttachmentMarkdown[] } = {},
): KStartupExtractionInput {
  const sourceId = String(announcement.pbanc_sn);
  const title = clean(announcement.biz_pbanc_nm) || clean(announcement.intg_pbanc_biz_nm) || sourceId;
  const blocks: KStartupExtractionBlock[] = [
    apiBlock("공고명", "biz_pbanc_nm", title),
    apiBlock("신청대상 요약", "aply_trgt", announcement.aply_trgt),
    apiBlock("신청대상 상세", "aply_trgt_ctnt", announcement.aply_trgt_ctnt),
    apiBlock("신청 제외대상", "aply_excl_trgt_ctnt", announcement.aply_excl_trgt_ctnt),
    apiBlock("우대사항", "prfn_matr", announcement.prfn_matr),
    apiBlock("지원지역", "supt_regin", announcement.supt_regin),
    apiBlock("지원분류", "supt_biz_clsfc", announcement.supt_biz_clsfc),
  ].filter(hasText);

  const detail = announcement.detail;
  if (detail?.apply_method_text) {
    blocks.push({
      label: "상세 신청방법",
      source: "detail_section",
      source_field: "detail.apply_method_text",
      text: clean(detail.apply_method_text),
    });
  }
  if (detail?.submit_documents_text) {
    blocks.push({
      label: "상세 제출서류",
      source: "detail_section",
      source_field: "detail.submit_documents_text",
      text: clean(detail.submit_documents_text),
    });
  }
  for (const attachment of options.attachmentMarkdowns ?? []) {
    const text = clean(attachment.markdown);
    if (!text) continue;
    blocks.push({
      label: `첨부 변환문서: ${attachment.filename}`,
      source: "attachment_markdown",
      filename: attachment.filename,
      text,
    });
  }

  return {
    source: "kstartup",
    source_id: sourceId,
    title,
    category: nullable(announcement.supt_biz_clsfc),
    blocks,
    text: render(sourceId, title, blocks),
  };
}

function apiBlock(
  label: string,
  sourceField: keyof KStartupAnnouncement,
  value: string | number | null | undefined,
): KStartupExtractionBlock {
  return { label, source: "api_field", source_field: sourceField, text: clean(value) };
}

function hasText(block: KStartupExtractionBlock): boolean {
  return block.text.length > 0;
}

function render(sourceId: string, title: string, blocks: KStartupExtractionBlock[]): string {
  return [
    "[K-Startup 지원사업 추출 입력]",
    `source_id: ${sourceId}`,
    `title: ${title}`,
    ...blocks.map((block) => [
      `\n## ${block.label}`,
      block.source_field ? `source_field: ${String(block.source_field)}` : undefined,
      block.filename ? `filename: ${block.filename}` : undefined,
      block.text,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function clean(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function nullable(value: string | null | undefined): string | null {
  return clean(value) || null;
}

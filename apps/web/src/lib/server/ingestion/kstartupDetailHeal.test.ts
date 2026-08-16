import assert from "node:assert/strict";
import type { KStartupDetailContent } from "@cunote/core";
import { isKStartupDetailMateriallyEqual } from "./kstartupDetailHeal";

const previous: KStartupDetailContent = {
  parser_version: "kstartup-detail-v1",
  fetched_at: "2026-08-09T17:30:51.000Z",
  apply_method_text: "이메일 접수",
  submit_documents_text: "신청서 1부",
  attachments: [{ filename: "신청서.hwp", url: "https://example.com/form" }],
};
const archivedAttachments = [{
  filename: "신청서.hwp",
  url: "https://example.com/archive/form",
  source_uri: "https://example.com/form",
  sha256: "a".repeat(64),
  storage_key: "archive/form.hwp",
}];

assert.equal(isKStartupDetailMateriallyEqual({
  previousDetail: previous,
  currentDetail: { ...previous, fetched_at: "2026-08-16T17:30:51.000Z" },
  previousAttachments: archivedAttachments,
  currentAttachments: archivedAttachments,
}), true, "관측 시각만 바뀐 상세 재수집은 material revision이 아니다");

assert.equal(isKStartupDetailMateriallyEqual({
  previousDetail: previous,
  currentDetail: {
    ...previous,
    fetched_at: "2026-08-16T17:30:51.000Z",
    apply_method_text: "온라인 접수",
  },
  previousAttachments: archivedAttachments,
  currentAttachments: archivedAttachments,
}), false, "신청 방법이 바뀌면 material revision이다");

assert.equal(isKStartupDetailMateriallyEqual({
  previousDetail: previous,
  currentDetail: { ...previous, fetched_at: "2026-08-16T17:30:51.000Z" },
  previousAttachments: archivedAttachments,
  currentAttachments: [{ ...archivedAttachments[0]!, sha256: "b".repeat(64) }],
}), false, "보관 첨부 결속이 바뀌면 material revision이다");

import assert from "node:assert/strict";
import {
  classifyAuthoringMode,
  deriveKStartupAuthoringMode,
  type KStartupAnnouncement,
} from "../src/index.js";

// ── 규칙 1: 서식성 첨부 존재 → file_form ──────────────────────────────
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: ["사업계획서.hwp"],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: [],
  }),
  "file_form",
);
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: ["○○지원사업 신청서양식.hwpx"],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: [],
  }),
  "file_form",
);
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: ["지원서.docx", "안내문.pdf"],
    attachmentsKnown: true,
    applyMethods: ["email"],
    applyMethodTexts: [],
  }),
  "file_form",
);
// 서식 키워드는 있으나 확장자가 문서형이 아니면(zip/pdf) 규칙 1 미매칭.
assert.notEqual(
  classifyAuthoringMode({
    attachmentFilenames: ["신청서.pdf"],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: [],
  }),
  "file_form",
);

// ── 규칙 2: 제출서류 텍스트 신호 → file_form (규칙 5보다 우선) ──────────
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: true, // online + 수집됐지만 규칙 5(web_form) 전에 규칙 2가 이긴다
    applyMethods: ["online"],
    applyMethodTexts: [],
    submitDocumentsText: "지정 양식을 작성하여 온라인 제출",
  }),
  "file_form",
);
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: [],
    submitDocumentsText: "붙임 서식을 작성 후 업로드",
  }),
  "file_form",
);

// ── 규칙 3: 웹폼 명시 → web_form ──────────────────────────────────────
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: ["구글폼으로 신청 접수"],
  }),
  "web_form",
);
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: [],
    submitDocumentsText: "온라인 설문으로 접수",
  }),
  "web_form",
);
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: ["시스템에 직접 입력하여 신청"],
  }),
  "web_form",
);

// ── 규칙 4: online 채널 없음 → file_form (이메일/팩스/우편/방문뿐) ──────
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: false,
    applyMethods: ["email"],
    applyMethodTexts: ["담당자 이메일로 제출"],
  }),
  "file_form",
);
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: false,
    applyMethods: ["visit", "postal"],
    applyMethodTexts: [],
  }),
  "file_form",
);

// ── 규칙 5: 첨부 수집됨 + online + 서식 없음 → web_form ────────────────
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: ["누리집에서 온라인 신청"],
  }),
  "web_form",
);

// ── 규칙 6: 신호 부족 → unknown ──────────────────────────────────────
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: false,
    applyMethods: [],
    applyMethodTexts: [],
  }),
  "unknown",
);

// ── 우선순위 충돌: 구글폼(규칙 3) + 사업계획서 양식(규칙 1) → file_form ──
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: ["사업계획서.hwp"],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: ["구글폼으로 접수"],
  }),
  "file_form",
);

// ── 첨부 미수집 소스에서 "첨부 없음" 이 web_form 으로 새지 않는지 ───────
// online 이지만 첨부 미수집(K-Startup detail 없음) → 규칙 5 불가 → unknown.
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: false,
    applyMethods: ["online"],
    applyMethodTexts: [],
  }),
  "unknown",
);
// 첨부 미수집 + online 없음 → 규칙 4 → file_form(web_form 아님).
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: [],
    attachmentsKnown: false,
    applyMethods: ["email"],
    applyMethodTexts: [],
  }),
  "file_form",
);

// ── 모집공고.hwpx 만 있는 경우(서식 키워드 미매칭) → 규칙 2~5 로 폴백 ────
// online 이면 규칙 5 → web_form.
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: ["○○지원사업 모집공고.hwpx"],
    attachmentsKnown: true,
    applyMethods: ["online"],
    applyMethodTexts: [],
  }),
  "web_form",
);
// online 없음이면 규칙 4 → file_form.
assert.equal(
  classifyAuthoringMode({
    attachmentFilenames: ["모집공고문.hwp"],
    attachmentsKnown: true,
    applyMethods: ["email"],
    applyMethodTexts: [],
  }),
  "file_form",
);

// ── deriveKStartupAuthoringMode: detail 이 normalize 이후에 붙는 수집 경로 회귀 방지 ──
// (enrichment/heal 이 이 헬퍼로 재판정하지 않으면 서식 첨부가 있어도 unknown 으로 발행된다.)
const kstartupOnlineRow = {
  aply_mthd_onli_rcpt_istc: "온라인 접수",
} as unknown as KStartupAnnouncement;
assert.equal(deriveKStartupAuthoringMode(kstartupOnlineRow), "unknown");
assert.equal(
  deriveKStartupAuthoringMode({
    ...kstartupOnlineRow,
    detail: {
      parser_version: "kstartup-detail-v1",
      fetched_at: "2026-07-08T00:00:00.000Z",
      apply_method_text: "온라인 접수",
      submit_documents_text: null,
      attachments: [{
        filename: "(별첨1) 창업기업 사업계획서.hwp",
        url: "https://www.k-startup.go.kr/afile/fileDownload/x",
      }],
    },
  }),
  "file_form",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "derive_kstartup_row_without_detail_unknown",
    "derive_kstartup_row_with_form_attachment_file_form",
    "rule1_form_attachment",
    "rule1_non_document_extension_skips",
    "rule2_submit_text_beats_rule5",
    "rule3_web_form_explicit",
    "rule4_no_online_channel",
    "rule5_known_attachments_online",
    "rule6_unknown",
    "priority_form_beats_web_form",
    "unknown_source_no_web_form_leak",
    "notice_only_hwpx_fallback",
  ],
}, null, 2));

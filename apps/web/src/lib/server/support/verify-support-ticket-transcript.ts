import assert from "node:assert/strict";
import {
  renderSupportTicketTranscript,
  supportTicketTranscriptDownloadResponse,
  type SupportTicketTranscript,
} from "./supportTicketTranscript";

const markdown = renderSupportTicketTranscript({
  generatedAt: new Date("2026-06-30T09:30:00.000Z"),
  ticket: {
    id: "ticket-verify-transcript",
    category: "bug",
    subject: "지원서류 초안 저장 오류",
    status: "waiting",
    priority: "high",
    email: "founder@example.com",
    createdAt: "2026-06-29T01:00:00.000Z",
    updatedAt: "2026-06-30T08:00:00.000Z",
    responseDueAt: "2026-07-01",
  },
  attachments: [{
    id: "attachment-verify-1",
    ticketId: "ticket-verify-transcript",
    messageId: null,
    filename: "오류 화면 | 재현.png",
    contentType: "image/png",
    bytes: 18432,
    sizeLabel: "18 KB",
    sha256: "sha256-verify",
    archiveUrl: "https://r2.example.test/support/error.png",
    visibility: "public",
    status: "active",
    createdAt: "2026-06-29T01:05:00.000Z",
    updatedAt: "2026-06-29T01:05:00.000Z",
  }],
  thread: [
    {
      id: "ticket-verify-transcript:initial",
      authorType: "user",
      body: "초안 저장을 누르면 오류가 납니다.\n재현 경로를 첨부했습니다.",
      createdAt: "2026-06-29T01:00:00.000Z",
    },
    {
      id: "message-public-admin",
      authorType: "admin",
      body: "확인했습니다. 저장 API를 다시 실행해 주세요.",
      createdAt: "2026-06-30T08:00:00.000Z",
    },
  ],
});

assert(markdown.startsWith("# 지원서류 초안 저장 오류 문의 기록"));
assert(markdown.includes("생성: 2026."));
assert(markdown.includes("내부 운영 메모와 담당자 정보는 포함하지 않습니다."));
assert(markdown.includes("| 접수번호 | ticket-verify-transcript |"));
assert(markdown.includes("| 상태 | 답변 완료 |"));
assert(markdown.includes("| 우선순위 | 높음 |"));
assert(markdown.includes("| 예상 응답 기준 | 2026-07-01 |"));
assert(markdown.includes("오류 화면 \\| 재현.png"));
assert(markdown.includes("https://r2.example.test/support/error.png"));
assert(markdown.includes("### 나 · 2026."));
assert(markdown.includes("### 창업노트 · 2026."));
assert(markdown.includes("초안 저장을 누르면 오류가 납니다."));
assert(markdown.includes("확인했습니다. 저장 API를 다시 실행해 주세요."));
assert.equal(markdown.includes("내부 전용 조치"), false);

const transcript: SupportTicketTranscript = {
  filename: "창업노트-지원서류 초안 저장 오류-문의기록.md",
  fallbackFilename: "cunote-support-ticket-ticket-v.md",
  markdown,
};
const response = supportTicketTranscriptDownloadResponse(transcript);

assert.equal(response.headers.get("content-type")?.includes("text/markdown"), true);
assert.equal(response.headers.get("content-disposition")?.includes("attachment"), true);
assert.equal(response.headers.get("content-disposition")?.includes("filename*=UTF-8''"), true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "support_ticket_transcript_heading",
    "support_ticket_transcript_summary",
    "support_ticket_transcript_attachment_table",
    "support_ticket_transcript_public_thread",
    "support_ticket_transcript_download_headers",
  ],
}, null, 2));

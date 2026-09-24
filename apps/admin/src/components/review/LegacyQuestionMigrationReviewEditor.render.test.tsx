import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

(globalThis as typeof globalThis & { React: typeof React }).React = React
const { LegacyQuestionMigrationReviewEditor } = await import("./LegacyQuestionMigrationReviewEditor")

const html = renderToStaticMarkup(
  React.createElement(LegacyQuestionMigrationReviewEditor, {
    actorEmail: "logged-in-actor@example.invalid",
  }),
)

assert.match(html, /사람 검수 결정을 기록하는 로컬 도구/)
assert.match(html, /서비스 DB, 기존 질문, v2 초안, release에는 아무 변경도 하지 않습니다/)
assert.match(html, /type="file"/)
assert.match(html, /multiple=""/)
assert.match(html, /파일은 서버로 전송되지 않습니다/)
assert.match(html, /누락·추가 파일, snapshot 혼합, 내용 SHA 불일치/)
assert.doesNotMatch(html, /fetch\(|업로드 완료/)

console.log(JSON.stringify({
  ok: true,
  checked: [
    "local_multi_file_boundary",
    "no_service_write_claim",
    "exact_bundle_validation_copy",
  ],
  htmlBytes: Buffer.byteLength(html),
}, null, 2))

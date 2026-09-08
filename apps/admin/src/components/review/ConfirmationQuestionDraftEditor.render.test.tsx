import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

(globalThis as typeof globalThis & { React: typeof React }).React = React
const {
  ConfirmationQuestionDraftEditor,
  updateQuestionOptionLabel,
  updateQuestionPrompt,
} = await import("./ConfirmationQuestionDraftEditor")

const html = renderToStaticMarkup(
  React.createElement(ConfirmationQuestionDraftEditor, {
    actorEmail: "logged-in-actor@example.invalid",
  }),
)

assert.match(html, /로컬 파일 편집기/)
assert.match(html, /서비스 DB·실제 질문·release·selector는 변경하지 않습니다/)
assert.match(html, /현재 서비스 source revision·상태 재대조는 이 화면과 manual CLI가 하지 않으며/)
assert.match(html, /type="file"/)
assert.match(html, /파일은 서버에 업로드되지 않습니다/)
assert.match(html, /내보낸 bound 파일을 다시 가져오면/)
assert.doesNotMatch(html, /fetch\(|업로드 완료/)

const editableItem = {
  criterionIndex: 0,
  criterionKind: "required" as const,
  polarity: "criterion_satisfaction" as const,
  criterionSha256: "a".repeat(64),
  sourceSpan: "검증된 원문",
  resolutionScope: "per_notice" as const,
  answerType: "single" as const,
  prompt: "기존 질문",
  options: [
    { value: "yes" as const, label: "예", evaluation: "satisfied" as const },
    { value: "no" as const, label: "아니요", evaluation: "unsatisfied" as const },
    { value: "unknown" as const, label: "모름", evaluation: "unknown" as const },
  ],
  decision: "pending" as const,
}
const promptValueCapturedBeforeDeferredUpdate = "즉시 캡처한 질문"
assert.equal(
  updateQuestionPrompt(promptValueCapturedBeforeDeferredUpdate)(editableItem).prompt,
  promptValueCapturedBeforeDeferredUpdate,
)
const optionLabelCapturedBeforeDeferredUpdate = "즉시 캡처한 선택지"
assert.equal(
  updateQuestionOptionLabel(1, optionLabelCapturedBeforeDeferredUpdate)(editableItem).options[1]?.label,
  optionLabelCapturedBeforeDeferredUpdate,
)

console.log(JSON.stringify({
  ok: true,
  checked: [
    "offline_file_boundary",
    "no_service_write_claim",
    "cli_current_revalidation_boundary",
    "local_file_input",
    "deferred_state_update_uses_captured_values",
  ],
  htmlBytes: Buffer.byteLength(html),
}, null, 2))

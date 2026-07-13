import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { PriorAwardHistoryEditor } = await import("./PriorAwardHistoryEditor");

const html = renderToStaticMarkup(
  React.createElement(PriorAwardHistoryEditor, {
    profile: {
      prior_award_history: {
        records: [{ program: "tips", state: "completed", year: 2025 }],
        self_flags: { current_similar: false },
        known_programs: ["tips"],
        known_program_types: [],
      },
      confidence: { prior_award: 0.6 },
    },
    onSaved: () => undefined,
  }),
);

assert.match(html, /수혜·참여 이력 정정/);
assert.match(html, /현재 동일·유사 정부지원 수행·수혜/);
assert.match(html, /다른 창업보육센터·BI 중복입주/);
assert.match(html, /TIPS/);
assert.match(html, /2025/);
assert.match(html, /수혜 이력 저장/);
assert.match(html, /미확인은 판정을 보류/);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "prior_award_editor_ssr",
    "self_scope_controls",
    "incubation_control",
    "existing_record_render",
    "known_program_render",
    "save_action_render",
    "unknown_safety_copy",
  ],
  htmlBytes: Buffer.byteLength(html),
}, null, 2));

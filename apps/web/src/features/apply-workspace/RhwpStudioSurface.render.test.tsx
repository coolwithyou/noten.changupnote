import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { RhwpStudioSurface } = await import("./RhwpStudioSurface");

const html = renderToStaticMarkup(
  <RhwpStudioSurface
    draftId="00000000-0000-4000-8000-000000000001"
    answers={{}}
    quickFields={[]}
    manualAnchors={[]}
    duplicateLabels={new Set()}
    workingDocument={null}
    headMaterializedAnswers={{}}
    activeTask={null}
    onSaved={() => undefined}
  />,
);

assert.ok(html.includes("지금 저장"), "Studio 작업본을 서버에 저장하는 버튼이 보여야 합니다.");
assert.ok(
  html.includes("수정 후 직접 저장이 필요해요"),
  "legacy Studio에서는 자동 저장을 가장하지 않고 수동 저장 필요 상태를 보여야 합니다.",
);
assert.ok(
  html.includes("저장하고 빠른 작성으로"),
  "저장 후 빠른 작성으로 복귀하는 별도 버튼이 보여야 합니다.",
);

console.log("RhwpStudioSurface dual save actions render test passed");

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
    activeTask={null}
    onSaved={() => undefined}
  />,
);

assert.ok(html.includes("임시 저장"), "Studio에 머무르는 임시 저장 버튼이 보여야 합니다.");
assert.ok(
  html.includes("저장하고 빠른 작성으로"),
  "저장 후 빠른 작성으로 복귀하는 별도 버튼이 보여야 합니다.",
);

console.log("RhwpStudioSurface dual save actions render test passed");

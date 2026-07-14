import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { LookupSuggestions } = await import("./lookup-suggestions");

const suggestion: BusinessLookupSuggestion = {
  id: "account:2378603641",
  bizNo: "2378603641",
  bizNoFormatted: "237-86-03641",
  bizNoMasked: "237-**-*****",
  companyName: "상호 미확인",
  industry: null,
  businessType: null,
  checkedAt: null,
  lastLookupAt: "2026-07-15T00:00:00.000Z",
  source: "account",
  cacheSource: "saved_profile",
};

const html = renderToStaticMarkup(
  <LookupSuggestions
    suggestions={[suggestion]}
    deletingSuggestionIds={new Set()}
    onSelect={() => undefined}
    onDelete={() => undefined}
  />,
);

assert.match(html, /상호 미확인/);
assert.match(html, /237-86-03641/);
assert.match(html, /내 계정/);
assert.match(html, /최근 조회 기록 삭제/);
assert.equal((html.match(/<button/g) ?? []).length, 2, "selection and delete are separate buttons");

console.log("lookup suggestions render: ok");

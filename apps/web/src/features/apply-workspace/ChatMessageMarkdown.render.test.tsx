import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessageMarkdown } from "./ChatMessageMarkdown";

const markdown = [
  "## 작성 요령",
  "",
  "1. **사용자**를 구체적으로 적습니다.",
  "2. 시장의 `차별점`을 설명합니다.",
  "",
  "[공고 원문](https://example.com/grant)",
].join("\n");

const html = renderToStaticMarkup(<ChatMessageMarkdown>{markdown}</ChatMessageMarkdown>);
assert.match(html, /<ol/);
assert.match(html, /<strong>사용자<\/strong>/);
assert.match(html, /<code[^>]*>차별점<\/code>/);
assert.match(html, /target="_blank"/);
assert.match(html, /rel="noreferrer"/);
assert.doesNotMatch(html, /\*\*사용자\*\*/);

const partialStreamHtml = renderToStaticMarkup(
  <ChatMessageMarkdown>{"1. **사용자** - 누구에게 제공할 것인지\n2. **세부 내용** -"}</ChatMessageMarkdown>,
);
assert.match(partialStreamHtml, /<strong>사용자<\/strong>/);
assert.match(partialStreamHtml, /<strong>세부 내용<\/strong>/);

const unsafeHtml = renderToStaticMarkup(
  <ChatMessageMarkdown>{'<script>alert("x")</script>\n![추적 이미지](https://example.com/pixel.gif)'}</ChatMessageMarkdown>,
);
assert.doesNotMatch(unsafeHtml, /<script|<img|alert\(&quot;x&quot;\)/);
assert.match(unsafeHtml, /이미지: 추적 이미지/);

console.log("chat markdown render tests passed");

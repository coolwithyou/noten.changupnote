import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { AppHeader } = await import("./app-header");

const user = { name: "Owner", email: "owner@example.com" };
const ownerHtml = renderToStaticMarkup(
  <AppHeader user={user} showGrantSimulation />,
);
assert.match(ownerHtml, /href="\/internal\/review\/grants"/);
assert.match(ownerHtml, />지원서 시뮬레이션</);
assert.match(ownerHtml, />내 신청 현황</);
assert.match(ownerHtml, />내 정보</);

const generalUserHtml = renderToStaticMarkup(<AppHeader user={user} />);
assert.doesNotMatch(generalUserHtml, /\/internal\/review\/grants/);
assert.doesNotMatch(generalUserHtml, />지원서 시뮬레이션</);

const signedOutHtml = renderToStaticMarkup(
  <AppHeader user={null} showGrantSimulation />,
);
assert.doesNotMatch(signedOutHtml, /\/internal\/review\/grants/);

console.log("app header owner navigation: ok");

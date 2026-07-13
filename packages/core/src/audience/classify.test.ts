import assert from "node:assert/strict";
import { classifyGrantAudience } from "./classify.js";

assertClassification("kstartup structured company", {
  source: "kstartup", title: "사업화 지원", payload: { aply_trgt: "일반기업" },
}, "company", true);
assertClassification("kstartup structured individual", {
  source: "kstartup", title: "청소년 대상 진로 교육생 모집", payload: { aply_trgt: "청소년" },
}, "individual", true);
assertClassification("company plus preliminary founder is mixed", {
  source: "kstartup", title: "창업 지원", payload: { aply_trgt: "예비창업자, 창업기업", aply_trgt_ctnt: "예비창업자 대상 및 창업기업" },
}, "mixed", true);
assertClassification("keyword trap keeps participant company", {
  source: "kstartup", title: "청년 뉴리더 양성사업", payload: { aply_trgt_ctnt: "본 사업에 참여할 중소기업을 모집합니다." },
}, "company", true);
assertClassification("contest keyword alone does not mean individual", {
  source: "kstartup", title: "반려동물 창업 공모전 참가자 모집", payload: {},
}, "unknown", false);
assertClassification("bizinfo company target", {
  source: "bizinfo", title: "수출 지원", payload: { trgetNm: "중소기업" },
}, "company", true);
assertClassification("company representative age is not mixed audience", {
  source: "bizinfo", title: "청년창업특례보증", payload: { trgetNm: "중소기업", bsnsSumryCn: "만 39세 이하 대표자의 창업기업" },
}, "company", true);
assertClassification("individual and corporate business operators are company audience", {
  source: "bizinfo", title: "소상공인 지원", payload: { trgetNm: "소상공인", bsnsSumryCn: "개인ㆍ법인사업자가 신청할 수 있습니다." },
}, "company", true);
assertClassification("explicit person or company is mixed audience", {
  source: "bizinfo", title: "컨설팅", payload: { trgetNm: "중소기업", bsnsSumryCn: "관심 있는 개인ㆍ기업이 신청할 수 있습니다." },
}, "mixed", true);
assertClassification("individual age rule", {
  source: "kstartup", title: "교육생 모집", payload: { aply_trgt_ctnt: "신청일 기준 만 19세 이상 일반인을 대상으로 합니다." },
}, "individual", true);

const unknown = classifyGrantAudience({ source: "bizinfo", title: "지원사업", payload: {} });
assert.equal(unknown.audience, "unknown");
assert.equal(unknown.safeToExcludeFromBusinessMatching, false);
const uncorroboratedStructured = classifyGrantAudience({
  source: "kstartup", title: "BI 매니저 워크숍", payload: { aply_trgt: "일반인" },
});
assert.equal(uncorroboratedStructured.audience, "unknown");
assert.equal(uncorroboratedStructured.safeToExcludeFromBusinessMatching, false);
console.log("audience/classify.test.ts: all assertions passed");

function assertClassification(
  name: string,
  input: Parameters<typeof classifyGrantAudience>[0],
  expected: ReturnType<typeof classifyGrantAudience>["audience"],
  hasSignals: boolean,
): void {
  const actual = classifyGrantAudience(input);
  assert.equal(actual.audience, expected, name);
  assert.equal(actual.signals.length > 0, hasSignals, `${name}: signals`);
  if (actual.audience === "individual") assert.equal(actual.safeToExcludeFromBusinessMatching, true, name);
}

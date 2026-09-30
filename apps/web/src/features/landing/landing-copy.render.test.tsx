import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const [{ BizLookupProvider }, { LandingHero, LANDING_HERO_COPY }, { HowItWorks }] = await Promise.all([
  import("./biz-lookup-context"),
  import("./landing-hero"),
  import("./marketing-sections"),
]);

// 디자인 2라운드 05 랜딩 히어로: 아이브로·헤드라인 3행·서브·신뢰 문장·CTA "내 회사로 시작".
const heroHtml = renderToStaticMarkup(
  <BizLookupProvider>
    <LandingHero openCount={12} comparisonCount={340} />
  </BizLookupProvider>,
);
for (const text of [LANDING_HERO_COPY.eyebrow, ...LANDING_HERO_COPY.headline, LANDING_HERO_COPY.sub, LANDING_HERO_COPY.trust]) {
  assert.ok(heroHtml.includes(text), `히어로에 디자인 문구가 있어야 합니다: ${text}`);
}
assert.match(heroHtml, />내 회사로 시작<\/button>/, "주 CTA 라벨은 '내 회사로 시작'이어야 합니다.");
assert.doesNotMatch(heroHtml, /지원사업 조건을 확인하세요|내 사업자 정보를 완성하고|입력 정보는 암호화돼요|지원사업 찾기/, "옛 히어로 문구가 남아 있으면 안 됩니다.");
assert.doesNotMatch(heroHtml, /지원 가능|매칭률|선정 확률|자동으로 완성/, "금지 어휘가 히어로에 나오면 안 됩니다.");

// 특징 3열: 제목·설명문은 05 소스 그대로, 번호는 01/02/03.
const featuresHtml = renderToStaticMarkup(<HowItWorks />);
for (const text of [
  "관련 공고를 넓게 봅니다",
  "확인한 필수조건이 맞지 않는 공고만 제외하고, 제외한 이유와 근거·기준일을 공개해요. 우대 조건이나 업종 키워드로는 제외하지 않아요.",
  "회사 자료로 문항을 씁니다",
  "회사소개서·결산 요약을 연결하고 이번 사업 설명을 적으면, 문단마다 회사 자료 기반·이번 사업 계획·검토할 제안을 구분한 초안과 인용 근거를 드려요.",
  "원본 양식 그대로 저장합니다",
  "HWP·HWPX 원본을 열어 편집하고 서버에 저장해요. 문안 저장과 파일 반영을 구분해 보여주고, 다운로드가 제출 완료가 아니라는 점도 숨기지 않아요.",
  ">01<",
  ">02<",
  ">03<",
]) {
  assert.ok(featuresHtml.includes(text), `특징 3열에 디자인 문구가 있어야 합니다: ${text}`);
}
assert.doesNotMatch(featuresHtml, /사업자 정보 완성|맞춤 매칭|검토하며 지원서 작성/, "옛 3단계 문구가 남아 있으면 안 됩니다.");

console.log("landing copy render: ok");

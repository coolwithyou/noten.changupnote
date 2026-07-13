import assert from "node:assert/strict";
import type { CompanyProfile, Grant } from "@cunote/contracts";
import { calculateRelevance } from "./relevance.js";

const company: CompanyProfile = {
  industries: ["소프트웨어 개발"],
  industry_codes: ["J62"],
  other_conditions: { interest_goals: ["수출", "R&D"] },
};

const relevant = calculateRelevance(company, grant({
  title: "AI 소프트웨어 해외진출 지원사업",
  f_industries: ["J62", "소프트웨어 개발"],
}));
assert.equal(relevant.score, 100);
assert.ok(relevant.reasons.some((reason) => reason.includes("업종")));
assert.ok(relevant.reasons.some((reason) => reason.includes("수출")));

const unrelated = calculateRelevance(company, grant({
  title: "농식품 제조시설 개선사업",
  f_industries: ["C10", "식료품 제조업"],
}));
assert.equal(unrelated.score, 0);

const genericDevelopment = calculateRelevance({ industries: ["소프트웨어 개발"], industry_codes: ["J62"] }, grant({
  title: "첨단부품 제조기업 기술개발 지원사업",
  f_industries: ["제조업"],
}));
assert.equal(genericDevelopment.score, 0, "generic 개발/제조 tokens must not create industry relevance");

const softwareAlias = calculateRelevance(
  { industries: ["소프트웨어 개발"] },
  grant({ title: "콘텐츠 기업 지원", f_industries: ["SW"] }),
);
assert.equal(softwareAlias.score, 46, "SW must map to the software canonical token");

const foodAlias = calculateRelevance(
  { industries: ["식료품 제조업"] },
  grant({ title: "지역기업 지원", f_industries: ["농ㆍ식품 제조기업"] }),
);
assert.equal(foodAlias.score, 46, "농식품 variants must map to the food canonical token");

const insufficient = calculateRelevance({}, grant({ title: "일반 지원사업", f_industries: [] }));
assert.equal(insufficient.score, null);

const goalMustComeFromPurposeFields = calculateRelevance(
  { other_conditions: { interest_goals: ["사업화"] } },
  grant({ title: "외식서비스 경영혁신 지원", f_industries: ["창업기업"] }),
);
assert.equal(goalMustComeFromPurposeFields.score, 0, "industry values must not impersonate a company goal match");

const exclusionIsNotRelevance = calculateRelevance(
  { industries: ["도박업"] },
  grant({ title: "일반 지원", f_industries: [] }),
  [{
    dimension: "industry",
    operator: "not_in",
    kind: "exclusion",
    value: { tags: ["도박업"] },
    confidence: 0.9,
  }],
);
assert.equal(exclusionIsNotRelevance.score, null, "excluded industries must never create positive relevance");

function grant(overrides: Partial<Grant>): Grant {
  return {
    source: "kstartup",
    source_id: "test",
    title: "테스트 공고",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
    ...overrides,
  };
}

console.log("relevance.test.ts: all assertions passed");

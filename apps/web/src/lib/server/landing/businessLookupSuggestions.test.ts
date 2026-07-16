import assert from "node:assert/strict";
import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";
import { mergeBusinessLookupSuggestionDisplay } from "./businessLookupSuggestionDisplay";

const base: BusinessLookupSuggestion = {
  id: "account:2378603641",
  bizNo: "2378603641",
  bizNoFormatted: "237-86-03641",
  bizNoMasked: "237-**-03***",
  companyName: null,
  industry: null,
  businessType: null,
  checkedAt: "2026-07-06T12:55:48.591Z",
  lastLookupAt: "2026-07-15T00:00:00.000Z",
  source: "account",
  cacheSource: "popbill_cache",
};

const enriched = mergeBusinessLookupSuggestionDisplay(base, {
  companyName: "주식회사 노튼 (noten Co.,Ltd.)",
  industry: "소프트웨어 개발 및 공급업, 정보통신업",
  checkedAt: "2026-07-14T00:00:00.000Z",
});

assert.equal(enriched.companyName, "주식회사 노튼 (noten Co.,Ltd.)");
assert.equal(enriched.industry, "소프트웨어 개발 및 공급업, 정보통신업");
assert.equal(enriched.checkedAt, base.checkedAt, "기존 조회 시각은 합성 프로필 시각으로 덮지 않는다");
assert.equal(enriched.cacheSource, "product_profile_cache");

const alreadyComplete = mergeBusinessLookupSuggestionDisplay({
  ...base,
  companyName: "팝빌 확인 회사",
  industry: "정보통신업",
}, {
  companyName: "다른 캐시 회사",
  industry: "다른 업종",
  checkedAt: "2026-07-14T00:00:00.000Z",
});

assert.equal(alreadyComplete.companyName, "팝빌 확인 회사");
assert.equal(alreadyComplete.industry, "정보통신업");
assert.equal(alreadyComplete.cacheSource, "popbill_cache");

console.log("landing/businessLookupSuggestions.test.ts: all assertions passed");

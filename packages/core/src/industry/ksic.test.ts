/**
 * 업종(industry) 축 정밀화 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/industry/ksic.test.ts
 *
 * 커버: KSIC 사전 무결성(중분류의 대분류 귀속 전수), prefix 해석, 코드 확장,
 *       prefix 매칭 4케이스, 구형 캐시 마이그레이션(멱등), 혼합 배열→라벨/코드 분리,
 *       normalize 전업종 생략·명시 업종 룰, matchGrantCriteria 업종 코드/라벨 매칭.
 */
import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import {
  KSIC_DIVISIONS,
  KSIC_SECTIONS,
  expandKsicCodes,
  industryCodeMatches,
  isLikelyKsicCode,
  ksicDivisionLabel,
  ksicSectionLabel,
  resolveKsic,
  splitIndustryEntries,
} from "./ksic.js";
import {
  buildCompanyProfileFromPopbill,
  normalizeCompanyIndustryProfile,
} from "../company/profile-from-popbill.js";
import { buildKStartupCriteria } from "../kstartup/normalize.js";
import { matchGrantCriteria } from "../matching/match.js";
import type { KStartupAnnouncement } from "../kstartup/types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. 사전 무결성 ─────────────────────────────────────────────
check("대분류 21개(A~U), 중분류 77개", () => {
  assert.equal(KSIC_SECTIONS.length, 21);
  assert.equal(KSIC_DIVISIONS.length, 77);
});

check("중분류가 모두 유효 대분류에 속하고, 코드는 2자리 숫자·유일하다(전수)", () => {
  const sectionCodes = new Set(KSIC_SECTIONS.map((section) => section.code));
  const seen = new Set<string>();
  for (const division of KSIC_DIVISIONS) {
    assert.match(division.code, /^\d{2}$/, `중분류 코드 형식 오류: ${division.code}`);
    assert.ok(!seen.has(division.code), `중분류 코드 중복: ${division.code}`);
    seen.add(division.code);
    assert.ok(sectionCodes.has(division.section), `${division.code}의 대분류 ${division.section} 미존재`);
    assert.ok(division.label.trim().length > 0, `${division.code} 명칭 비어있음`);
  }
});

check("대분류 코드는 A~U 유일값", () => {
  const codes = KSIC_SECTIONS.map((section) => section.code);
  assert.deepEqual(codes, [...new Set(codes)]);
  for (const code of codes) assert.match(code, /^[A-U]$/);
});

// ── 2. resolveKsic prefix 해석 ─────────────────────────────────
check("숫자 코드 prefix 축약: 58222/58200 → 중분류 58, 대분류 J", () => {
  const a = resolveKsic("58222");
  assert.equal(a.division?.code, "58");
  assert.equal(a.section?.code, "J");
  const b = resolveKsic("58200"); // KSIC에 없는 패딩성 코드도 앞 2자리로 수렴
  assert.equal(b.division?.code, "58");
  assert.equal(b.section?.code, "J");
});

check("문자접두 코드: J62 → 62/J, C25 → 25/C, 대분류 C → 섹션", () => {
  assert.equal(resolveKsic("J62").division?.code, "62");
  assert.equal(resolveKsic("C25").division?.code, "25");
  assert.equal(resolveKsic("C25").section?.code, "C");
  const bare = resolveKsic("C");
  assert.equal(bare.level, "section");
  assert.equal(bare.section?.code, "C");
});

check("해석 불가 코드는 level none", () => {
  assert.equal(resolveKsic("ZZ").level, "none");
  assert.equal(resolveKsic("").level, "none");
  assert.equal(resolveKsic("09").level, "none"); // 09는 어느 대분류에도 없음
});

check("라벨 헬퍼", () => {
  assert.equal(ksicDivisionLabel("58222"), "출판업");
  assert.equal(ksicSectionLabel("58222"), "정보통신업");
  assert.equal(ksicDivisionLabel("정보통신업"), null);
});

// ── 3. 코드 판정 & 확장 ────────────────────────────────────────
check("isLikelyKsicCode: 코드와 라벨 구분", () => {
  assert.equal(isLikelyKsicCode("58222"), true);
  assert.equal(isLikelyKsicCode("J62"), true);
  assert.equal(isLikelyKsicCode("C"), true);
  assert.equal(isLikelyKsicCode("정보통신업"), false);
  assert.equal(isLikelyKsicCode("ICT"), false);
  assert.equal(isLikelyKsicCode("SaaS"), false);
  assert.equal(isLikelyKsicCode("AI"), false);
});

check("expandKsicCodes: 원코드+중분류+대분류", () => {
  assert.deepEqual(expandKsicCodes("58222"), ["58222", "58", "J"]);
  assert.deepEqual(expandKsicCodes("J62"), ["J62", "62", "J"]);
  assert.deepEqual(expandKsicCodes("C25"), ["C25", "25", "C"]);
  assert.deepEqual(expandKsicCodes("정보통신업"), []);
});

// ── 4. prefix 매칭 4케이스 ─────────────────────────────────────
check("industryCodeMatches 4케이스", () => {
  const softwareCompany = ["58222", "58", "J"];
  const metalCompany = ["25111", "25", "C"];
  // (1) 중분류 prefix: 공고 "58" ⊃ 회사 "58222"
  assert.equal(industryCodeMatches(["58"], softwareCompany), true);
  // (2) 대분류 문자: 공고 "C" ⊃ 회사 제조 중분류
  assert.equal(industryCodeMatches(["C"], metalCompany), true);
  // (3) 서로 다른 업종은 비매칭: 공고 "C25"(금속) vs SW 회사
  assert.equal(industryCodeMatches(["C25"], softwareCompany), false);
  // (4) 대분류 불일치: 공고 "58"(출판) vs 제조 회사
  assert.equal(industryCodeMatches(["58"], metalCompany), false);
});

// ── 5. 혼합 배열 분리 & 구형 캐시 마이그레이션 ─────────────────
check("splitIndustryEntries: 코드/'/' 결합 라벨 분리", () => {
  const legacy = [
    "58200",
    "시각 디자인업/일반 서적 출판업/전자상거래 소매업",
    "도매 및 소매업/정보통신업",
  ];
  const { labels, codes } = splitIndustryEntries(legacy);
  assert.deepEqual(codes, ["58200", "58", "J"]);
  assert.deepEqual(labels, [
    "시각 디자인업",
    "일반 서적 출판업",
    "전자상거래 소매업",
    "도매 및 소매업",
    "정보통신업",
  ]);
});

check("normalizeCompanyIndustryProfile: 구형 캐시 재정규화 + 멱등 + 신뢰도 상향", () => {
  const legacy: CompanyProfile = {
    industries: ["58222"],
    confidence: { industry: 0.6 },
  };
  const migrated = normalizeCompanyIndustryProfile(legacy);
  assert.deepEqual(migrated.industries, []);
  assert.deepEqual(migrated.industry_codes, ["58222", "58", "J"]);
  assert.equal(migrated.confidence?.industry, 0.7);
  // 멱등: 다시 넣어도 동일
  const again = normalizeCompanyIndustryProfile(migrated);
  assert.deepEqual(again.industries, migrated.industries);
  assert.deepEqual(again.industry_codes, migrated.industry_codes);
});

check("normalizeCompanyIndustryProfile: 업종 confidence 없으면 키를 만들지 않는다", () => {
  const migrated = normalizeCompanyIndustryProfile({ industries: ["58222"] });
  assert.equal(migrated.confidence?.industry, undefined);
  assert.deepEqual(migrated.industry_codes, ["58222", "58", "J"]);
});

// ── 6. profile-from-popbill 혼합 → 라벨/코드 분리 ──────────────
check("buildCompanyProfileFromPopbill: 라벨/코드 분리 + 0.7 상향", () => {
  const { profile, facts } = buildCompanyProfileFromPopbill({
    result: 100,
    corpName: "샘플",
    industryCode: "58222",
    bizClass: "시각 디자인업/일반 서적 출판업",
    bizType: "정보통신업",
  });
  assert.deepEqual(profile.industries, ["시각 디자인업", "일반 서적 출판업", "정보통신업"]);
  assert.deepEqual(profile.industry_codes, ["58222", "58", "J"]);
  assert.equal(profile.confidence?.industry, 0.7);
  assert.equal(facts.has_industry, true);
});

// ── 7. normalize 전업종/명시 업종 룰 ──────────────────────────
function kstartupRow(aplyTrgt: string, aplyExcl?: string): KStartupAnnouncement {
  return {
    pbanc_sn: 1,
    aply_trgt_ctnt: aplyTrgt,
    aply_excl_trgt_ctnt: aplyExcl,
  } as unknown as KStartupAnnouncement;
}

check("전업종(업종 무관)이면 industry criterion을 만들지 않는다", () => {
  const criteria = buildKStartupCriteria(kstartupRow("업종 제한 없음, 모든 창업기업 신청 가능"));
  assert.equal(criteria.filter((c) => c.dimension === "industry").length, 0);
});

check("명시 업종(제조업)은 KSIC 코드 criterion으로 구조화(needs_review 유지)", () => {
  const criteria = buildKStartupCriteria(kstartupRow("제조업 영위 중소기업 대상"));
  const industry = criteria.find((c) => c.dimension === "industry");
  assert.ok(industry);
  assert.equal(industry.operator, "in");
  assert.equal(industry.needs_review, true);
  assert.equal(industry.confidence, 0.6);
  assert.deepEqual((industry.value as { codes: string[] }).codes, ["C"]);
});

check("애매한 업종 언급은 placeholder(text_only) 유지", () => {
  const criteria = buildKStartupCriteria(kstartupRow("바이오 분야 유망 창업기업"));
  const industry = criteria.find((c) => c.dimension === "industry");
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

// ── 7-b. 명시 업종 룰 문맥 가드(제외대상 역전·우대 오탈락 방지) ──
check("제외대상에만 '숙박업 제외' → 신청대상은 구조화하지 않고 placeholder 유지", () => {
  // 신청대상은 애매한 힌트('분야')만, 제외대상에 '숙박업 제외'. 합본을 읽으면 관광·숙박 룰이 반전 발화한다.
  const criteria = buildKStartupCriteria(
    kstartupRow("혁신 분야 창업기업", "유흥·숙박업 등은 신청 제외"),
  );
  const industry = criteria.find((c) => c.dimension === "industry");
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("신청대상 '제조업 우대'는 가점 문맥이라 placeholder 유지(하드 required 금지)", () => {
  const criteria = buildKStartupCriteria(kstartupRow("제조업 우대 창업기업 모집"));
  const industry = criteria.find((c) => c.dimension === "industry");
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("신청대상 '제조업 영위 기업'(순수 긍정)은 codes ['C'] required로 구조화", () => {
  const criteria = buildKStartupCriteria(kstartupRow("제조업 영위 기업 모집"));
  const industry = criteria.find((c) => c.dimension === "industry");
  assert.ok(industry);
  assert.equal(industry.operator, "in");
  assert.equal(industry.kind, "required");
  assert.deepEqual((industry.value as { codes: string[] }).codes, ["C"]);
});

// ── 7-c. 실측 코퍼스 회귀 — 오탐 유형(줄바꿈 제외나열·다분야·전분야·HW/SW·규모절) ──
function industryOf(row: KStartupAnnouncement) {
  return buildKStartupCriteria(row).find((c) => c.dimension === "industry");
}

check("제외 나열 불릿(줄바꿈)의 '음식점업'은 구조화하지 않고 placeholder 유지", () => {
  // firstSentence 가드로는 못 잡던 줄바꿈/불릿 구조. 세그먼트 윈도에서 '제외'를 인식해야 한다.
  const industry = industryOf(
    kstartupRow("혁신 창업기업 모집\n▷ 지원제외업종: 금융 및 보험업, 부동산업, 숙박, 음식점업 등"),
  );
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("다분야 나열 '(IT관련업, 제조업, 디자인업, 서비스업 등)'은 단일 업종으로 구조화하지 않는다", () => {
  const industry = industryOf(
    kstartupRow("사업화 가능한 업종(IT관련업, 제조업, 디자인업, 서비스업 등)을 보유한 창업기업"),
  );
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("규모기준절 '광업·제조업·건설업 및 운수업 10명 미만'은 업종 제약으로 오인하지 않는다", () => {
  const industry = industryOf(
    kstartupRow("상시근로자 수 광업·제조업·건설업 및 운수업 10명 미만, 그 외 업종 5명 미만인 소상공인"),
  );
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("'하드웨어 또는 소프트웨어' 기술 서술은 SW 업종으로 구조화하지 않는다", () => {
  const industry = industryOf(kstartupRow("하드웨어 또는 소프트웨어를 개발하는 로봇 스타트업"));
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("'전 분야 환영'은 전업종으로 보아 industry criterion을 만들지 않는다", () => {
  const criteria = buildKStartupCriteria(
    kstartupRow("관광 및 로컬 기업 위주\n- 단, 전 분야 기업도 환영합니다"),
  );
  assert.equal(criteria.filter((c) => c.dimension === "industry").length, 0);
});

check("'업종 제한은 없으나' 도 전업종으로 처리한다(조사 '은/이' 허용)", () => {
  const criteria = buildKStartupCriteria(
    kstartupRow("업종 제한은 없으나 충남 서부내륙권 소재 창업기업"),
  );
  assert.equal(criteria.filter((c) => c.dimension === "industry").length, 0);
});

check("경계: '안전 분야'는 '전 분야'로 오인해 전업종 처리하지 않는다(placeholder 유지)", () => {
  const industry = industryOf(kstartupRow("안전 분야 유망 창업기업"));
  assert.ok(industry);
  assert.equal(industry.operator, "text_only");
});

check("원전 분야 매출·기술개발 실적은 특수 조건 text_only로 남긴다", () => {
  const criteria = buildKStartupCriteria(
    kstartupRow("최근 5년 이내 원전 분야 매출 또는 기술개발 참여실적 보유 기업"),
  );
  const special = criteria.find((c) => c.id?.endsWith(":special-domain-text"));
  assert.ok(special);
  assert.equal(special.dimension, "other");
  assert.equal(special.operator, "text_only");
  assert.equal(special.kind, "required");
  assert.match(special.source_span ?? "", /원전/);
});

check("원자력 인증보유 문구는 추천 승격 금지용 text_only 근거를 만든다", () => {
  const criteria = buildKStartupCriteria(
    kstartupRow("국내외 원자력 인증보유(KEPIC, ASME 등) 기업"),
  );
  const special = criteria.find((c) => c.id?.endsWith(":special-domain-text"));
  assert.ok(special);
  assert.equal(special.operator, "text_only");
  assert.match(special.source_span ?? "", /KEPIC|ASME|원자력/);
});

check("로봇 실증사업 문구도 특수 분야 확인 조건으로 남긴다", () => {
  const criteria = buildKStartupCriteria(kstartupRow("로봇 실증사업 지원 과제 수행 기업"));
  const special = criteria.find((c) => c.id?.endsWith(":special-domain-text"));
  assert.ok(special);
  assert.equal(special.dimension, "other");
  assert.equal(special.operator, "text_only");
});

// ── 8. matchGrantCriteria 업종 매칭 ───────────────────────────
const softwareProfile: CompanyProfile = {
  industries: [],
  industry_codes: ["58222", "58", "J"],
  confidence: { industry: 0.7 },
};

check("코드 배열 criterion → 회사 industry_codes prefix 매칭(공고 58 ⊃ 회사 58222)", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "industry",
    operator: "in",
    kind: "required",
    value: { codes: ["58"], labels: ["출판업"] },
    confidence: 0.6,
  }];
  const result = matchGrantCriteria(criteria, softwareProfile);
  assert.equal(result.rule_trace[0]?.result, "pass");
  assert.equal(result.eligibility, "eligible");
});

check("라벨 문자열 criterion(기존 {industries}) → 라벨 매칭 fallback", () => {
  const labeled: CompanyProfile = { industries: ["제조업"], confidence: { industry: 0.6 } };
  const criteria: GrantCriterion[] = [{
    dimension: "industry",
    operator: "in",
    kind: "required",
    value: { industries: ["제조업"], labels: ["제조업"] },
    confidence: 0.9,
  }];
  assert.equal(matchGrantCriteria(criteria, labeled).rule_trace[0]?.result, "pass");
});

check("제조업 제외(exclusion not_in) → SW 회사는 통과(비제외)", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "industry",
    operator: "not_in",
    kind: "exclusion",
    value: { codes: ["C"], labels: ["제조업"] },
    confidence: 0.9,
  }];
  assert.equal(matchGrantCriteria(criteria, softwareProfile).rule_trace[0]?.result, "pass");
});

console.log(`\nksic.test.ts: ${passed} checks passed.`);

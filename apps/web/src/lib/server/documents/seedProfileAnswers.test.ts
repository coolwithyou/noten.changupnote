/**
 * seedProfileAnswers 단위 테스트 (Apply Experience v2 · P2-7, node:assert, tsx 실행).
 *
 * 사용: pnpm test:seed-profile-answers
 *
 * 규범: §4.3 컨펌 규약(결정론 프로필 시드) · §8 Phase 2 P2-7.
 * 커버: mapped 필드 시드(suggested/profile/basis) · 멱등(기존 label 불변) · 미매핑/빈값 제외.
 */
import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import { PROFILE_SEED_BASIS, seedProfileFieldAnswers, type SeedFieldInput } from "./seedProfileAnswers";
import type { DraftFieldAnswers } from "./fieldAnswers";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const profile: CompanyProfile = {
  name: "주식회사 가나",
  region: { code: "11", label: "서울" },
  industries: ["소프트웨어", "AI"],
  revenue_krw: 500_000_000,
  employees_count: 12,
  certs: ["ISO9001"],
  ip: ["특허 제1234호"],
};

const fields: SeedFieldInput[] = [
  { label: "기업명", mappedCompanyField: "name", fieldId: "f-name" },
  { label: "소재지", mappedCompanyField: "region" },
  { label: "업종", mappedCompanyField: "industries" },
  { label: "매출액", mappedCompanyField: "revenue" },
  { label: "상시근로자", mappedCompanyField: "employees" },
  { label: "인증특허", mappedCompanyField: "certifications" },
  { label: "사업자등록번호", mappedCompanyField: "biz_no", fieldId: "f-biz-no" },
  { label: "대표자", mappedCompanyField: "representative_name" }, // 프로필 소스 없음 → 제외
  { label: "사업개요", mappedCompanyField: null }, // 매핑 없음 → 제외
];

console.log("seedProfileAnswers 단위 테스트\n");

check("프로필과 회사 식별정보를 suggested/profile/basis 로 시드", () => {
  const seeded = seedProfileFieldAnswers({
    fields,
    profile,
    identity: { businessNumber: "1234567890" },
    current: {},
  });
  assert.equal(seeded.기업명?.value, "주식회사 가나");
  assert.equal(seeded.기업명?.status, "suggested");
  assert.equal(seeded.기업명?.source, "profile");
  assert.equal(seeded.기업명?.basis, PROFILE_SEED_BASIS);
  assert.equal(seeded.기업명?.suggestedValue, "주식회사 가나");
  assert.equal(seeded.기업명?.fieldId, "f-name");
  assert.equal(seeded.소재지?.value, "서울");
  assert.equal(seeded.업종?.value, "소프트웨어, AI");
  assert.equal(seeded.매출액?.value, "500,000,000원");
  assert.equal(seeded.상시근로자?.value, "12명");
  assert.equal(seeded.인증특허?.value, "ISO9001, 특허 제1234호");
  assert.equal(seeded.사업자등록번호?.value, "123-45-67890");
  assert.equal(seeded.사업자등록번호?.fieldId, "f-biz-no");
});

check("프로필 소스 없는 매핑·미매핑 필드는 제외", () => {
  const seeded = seedProfileFieldAnswers({ fields, profile, current: {} });
  assert.ok(!("대표자" in seeded), "representative_name 은 시드 대상 아님");
  assert.ok(!("사업개요" in seeded), "매핑 없는 필드는 시드 대상 아님");
});

check("멱등: 기존 답변이 있는 label 은 불변", () => {
  const current: DraftFieldAnswers = {
    기업명: { value: "사용자수정상호", status: "edited", source: "user", updatedAt: "x" },
  };
  const seeded = seedProfileFieldAnswers({ fields, profile, current });
  assert.equal(seeded.기업명?.value, "사용자수정상호");
  assert.equal(seeded.기업명?.status, "edited");
  assert.equal(seeded.기업명?.source, "user");
  // 다른 필드는 정상 시드.
  assert.equal(seeded.소재지?.status, "suggested");
});

check("빈 프로필 값은 시드하지 않는다", () => {
  const seeded = seedProfileFieldAnswers({
    fields: [{ label: "기업명", mappedCompanyField: "name" }],
    profile: {},
    current: {},
  });
  assert.equal(Object.keys(seeded).length, 0);
});

check("사업자번호는 숫자 10자리 정본만 시드한다", () => {
  const target = [{ label: "사업자등록번호", mappedCompanyField: "biz_no" }];
  const formatted = seedProfileFieldAnswers({
    fields: target,
    profile: {},
    identity: { businessNumber: "123-45-67890" },
    current: {},
  });
  assert.equal(formatted.사업자등록번호?.value, "123-45-67890");

  const masked = seedProfileFieldAnswers({
    fields: target,
    profile: {},
    identity: { businessNumber: "123-**-67***" },
    current: {},
  });
  assert.ok(!("사업자등록번호" in masked), "마스킹 값은 원문처럼 시드하면 안 됨");

  const tooLong = seedProfileFieldAnswers({
    fields: target,
    profile: {},
    identity: { businessNumber: "12345678901" },
    current: {},
  });
  assert.ok(!("사업자등록번호" in tooLong), "10자리를 넘는 값은 잘라서 시드하면 안 됨");
});

console.log(`\n✅ ${passed}개 통과`);

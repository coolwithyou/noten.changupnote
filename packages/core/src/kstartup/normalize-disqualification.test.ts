/**
 * kstartup normalize × 결격 분해기 통합 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/kstartup/normalize-disqualification.test.ts
 *
 * 커버(plan §3 P4 · D7):
 *  - aply_excl_trgt_ctnt 배제 문구가 분해기를 통해 신설 결격 축으로 구조화된다.
 *  - C2(중복입주·프로그램 수료류)는 구조화되지 않고 other text_only 안전망만 남는다.
 *  - span 정책(M1): 결격 criterion 에 raw_text 전체 원문 복제가 없다.
 *  - normalizer version 이 v2 로 범프됐다.
 */
import assert from "node:assert/strict";
import { KSTARTUP_NORMALIZER_VERSION } from "./constants.js";
import { normalizeKStartupAnnouncement } from "./normalize.js";
import type { KStartupAnnouncement } from "./types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const asOf = new Date("2026-06-26T00:00:00.000+09:00");

function normalize(excl: string): ReturnType<typeof normalizeKStartupAnnouncement> {
  const row: KStartupAnnouncement = {
    pbanc_sn: 999001,
    biz_pbanc_nm: "결격 분해 통합 테스트 공고",
    aply_trgt_ctnt: "중소기업 대상",
    aply_excl_trgt_ctnt: excl,
    pbanc_rcpt_bgng_dt: "20260601",
    pbanc_rcpt_end_dt: "20260630",
  };
  return normalizeKStartupAnnouncement(row, { asOf, collectedAt: asOf });
}

check("normalizer version 이 v2 로 범프됐다(D7)", () => {
  assert.equal(KSTARTUP_NORMALIZER_VERSION, "kstartup-field-parser-v2");
});

check("배제 문구가 신설 결격 축으로 구조화되고 raw_text 복제가 없다(M1)", () => {
  const result = normalize(
    "국세·지방세 체납 중인 경우 · 채무불이행 등 금융 규제 중인 경우 · 정부사업 참여제한(부정수급) 등 제재 · 완전자본잠식 상태인 경우 · 휴·폐업 중인 경우",
  );
  const dims = new Set(result.criteria.map((c) => c.dimension));
  for (const dim of ["tax_compliance", "credit_status", "sanction", "financial_health", "business_status"]) {
    assert.ok(dims.has(dim as never), `${dim} 미구조화`);
  }
  // 결격 축 criterion 은 span 만 있고 raw_text 는 없다.
  for (const criterion of result.criteria) {
    if (["tax_compliance", "credit_status", "sanction", "financial_health"].includes(criterion.dimension)) {
      assert.equal(criterion.raw_text, undefined, `${criterion.dimension} raw_text 복제(M1 위반)`);
      assert.ok(criterion.parser_version === KSTARTUP_NORMALIZER_VERSION, "parser_version 불일치");
    }
  }
});

check("C2(중복입주·프로그램 수료)는 구조화되지 않고 other text_only 안전망만 남는다", () => {
  const result = normalize(
    "최근 5년 중복입주에 해당하는 사업자 · 청년창업사관학교를 수료하였거나 참여 중인 기업",
  );
  const dims = new Set(result.criteria.map((c) => c.dimension));
  assert.ok(!dims.has("prior_award"), "prior_award 생성됨(C2 위반)");
  // 결격 축 구조화가 없으므로(중복수혜류) other text_only placeholder 로 검수 유지.
  const other = result.criteria.find((c) => c.dimension === "other" && c.operator === "text_only");
  assert.ok(other, "중복수혜류 잔존 other placeholder 없음");
});

check("배제업종은 industry not_in 으로 구조화된다", () => {
  const result = normalize("일반유흥주점업, 무도유흥주점업, 블록체인 기반 암호화 자산 매매 및 중개업 등을 영위하는 기업");
  const industry = result.criteria.find((c) => c.dimension === "industry" && c.operator === "not_in");
  assert.ok(industry, "배제업종 industry not_in 없음");
  const codes = new Set((industry!.value as { codes?: string[] }).codes ?? []);
  assert.ok(codes.has("56211") && codes.has("63999"), "배제업종 KSIC 미매핑");
});

console.log(`\nkstartup normalize × 결격 분해 통합 검증 통과: ${passed}건`);

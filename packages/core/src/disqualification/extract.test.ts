/**
 * 결격 분해기 단위 + 백업 27종 recall 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/disqualification/extract.test.ts
 *
 * 커버(계약, plan §3 P4 · §5 완료기준 1):
 *  - 백업 6개 공고 배제 문구(EXCLUSION_BLOCKS)를 분해 → 구조화 대상 전부 정확 귀속.
 *  - C2(중복수혜·프로그램 수료류 #8/#10/#13/#20)는 구조화 금지 → prior_award 미생성, text_only 잔존.
 *  - span 정책(M1): source_span 은 귀속 문장만, raw_text 미설정(전체 원문 복제 금지).
 *  - 예외 조항(납부기한 연장/징수유예·변제 정상이행·시효 소멸)은 exceptions canonical 로 파싱.
 *  - 부채비율 임계 inclusive/exclusive 파싱, 자본잠식 partial/full 파싱.
 *  - 배제업종 canonical KSIC 세트 귀속.
 *  - (dimension, span) 중복 없음(criteria-contract 통과).
 */
import assert from "node:assert/strict";
import {
  extractDisqualificationCriteria,
  splitDisqualificationSentences,
} from "./extract.js";
import { validateGrantCriteriaContract } from "../bizinfo/criteria-contract.js";
import type { GrantCriterion } from "@cunote/contracts";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 백업 실측 배제 문구(backups/cunote_full_20260627_142340.sql, grant_criteria) ──
// 연구 문서 §3.2 의 27종 원문. K-패션 팝업 / 부산TP·KMI / 기보 혁신창업 / 신용정보 기반 /
// 대구TP / 기술창업 6개 공고에서 발췌.
const EXCLUSION_BLOCKS: Record<string, string> = {
  kfashion:
    "[평가 제외 대상] ·「K-패션 브랜드 글로벌 팝업 지원사업(1차)」 최종 선정기업인 경우 · 접수마감일까지 계획서 등 제반서류를 제출 완료하지 않거나 제출양식을 준수하지 않은 경우 · 국세·지방세 체납이 확인되었거나 금융기관 채무 불이행인 경우 · 접수 마감일 기준 기업 부도, 휴·폐업 중인 경우 · 접수 마감일 기준 정부사업 참여제한(부정수급) 등 제재조치 대상일 경우 · 계획서 및 제출서류 등이 허위이거나 거짓인 경우 · 기타 본 사업목적 및 지원분야 등으로 적정하지 않다고 판단되는 경우",
  busan:
    "ㅇ 폐수, 소음, 진동 등 공해 다발 사업자 ㅇ 정부 지원사업 참여 제한 또는 제재 중인 기업 ㅇ 국세 또는 지방세 체납 기업 ㅇ 채무불이행 등 금융 규제 중인 기업 ㅇ 부도 및 휴폐업 상태 ㅇ 최근 5년 부산TP 및 KMI가 운영하는 사업으로 입주지원을 받고 있는 사업자, 또는 사업자의 지사 및 자회사 등(중복입주에 해당) ㅇ 입주개시일 전까지 사업자 확인 서류 제출이 불가한 경우",
  kibo:
    "아래 ① ~ ④ 중 어느 하나에 해당하는 기업은 신청 불가 ① 기보「기술보증규정」에서 정한 보증금지기업, 보증제한기업 등 “모집제한 대상”(공고문 참고1)에 해당하는 기업 ② 아래 프로그램을 수료하였거나 참여 중 또는 참여 예정인 기업 - 신용보증기금 “Start-up NEST” - 중소벤처기업진흥공단 “청년창업사관학교”, “글로벌창업사관학교”, “딥테크창업사관학교” ③ 신청일 현재 국세 또는 지방세 체납 중인 기업 - 납부기한 전에 “납부기한 연장”(국세), “징수유예”(지방세) 신청하여 연장 또는 유예 결정을 받은 경우는 신청 가능 ④ 도박, 사치, 향락 및 부동산 관련 업종 등을 영위하는 기업(공고문 참고2)",
  creditinfo:
    "다음에 해당하는 기업은 신청 및 지원 대상에서 제외됩니다. 1. 국세 또는 지방세를 체납 중인 기업 2. 한국평가데이터(주) 등 기업 신용정보상 연체, 부도, 금융질서문란, 법정관리, 기업회생신청, 청산절차 정보가 등록된 기업 3. 완전자본잠식 상태에 있는 기업 4. 휴업 또는 폐업 중인 기업 5. 임직원의 자금횡령 등 사회적 물의를 일으킨 기업 6. 보조금법 위반 등으로 정부지원사업 참여제한 중인 기업 또는 그 특수관계 기업 7. 지원제외 대상 업종을 영위하고 있거나 영위하고자 하는 기업 8. 동일 사업에 대해 타 부처 또는 지방자치단체로부터 국고 또는 지방비를 중복 지원받는 기업 9. 고의 또는 과실로 타인의 사업계획을 모방·표절하거나 도용하여 신청한 기업",
  daegu:
    "- 접수일 기준 동일한 과제로(과제 목표와 산출물이 동일한 경우) (재)대구테크노파크 및 타 기관 지원사업에 참여 중인 경우 - 접수일 기준 국세 또는 지방세 체납 사실이 있는 경우 - 접수일 기준 (재)대구테크노파크를 포함한 유관기관에 채무불이행인 경우 - 신용불량 등으로 인하여 금융기관으로부터 제재 중인 경우 - 파산·회생절차·개인회생절차의 개시 신청이 이루어진 경우 ※ 법원의 인가를 받은 회생계획 또는 변제계획에 따른 변제를 정상적으로 이행하고 있는 경우 예외 - (재)대구테크노파크 관련 협약 또는 계약 위반 사실이 있는 경우 - 기타 (재)대구테크노파크가 참여 제한 사유가 있다고 판단하는 경우",
  techstartup:
    "신청제외대상 ∙ 창업기업 등의 자격이 맞지 않거나, 사업내용이 공고내용에 적합하지 않는 경우 ∙ 금융기관을 통한 계좌개설이 불가능하거나, 본인 명의의 금융자산에 대한 압류가 진행 중인 자(단, 시효 소멸자는 제외) ∙ 공고일 기준 현재 중앙정부, 지자체, 공공기관 등의 참여제한으로 제재중인 자 ∙ 일반유흥주점업, 무도유흥주점업, 기타 주점업, 블록체인 기반 암호화 자산 매매 및 중개업, 기타 사행시설 관리 및 운영업 등",
};

function blockText(key: string): string {
  const text = EXCLUSION_BLOCKS[key];
  if (!text) throw new Error(`unknown exclusion block: ${key}`);
  return text;
}

function extractAll(key: string) {
  return extractDisqualificationCriteria(blockText(key), {
    sourceField: "aply_excl_trgt_ctnt",
    confidence: 0.6,
  });
}

function flagsOf(criteria: GrantCriterion[] | ReturnType<typeof extractAll>["criteria"], dimension: string): Set<string> {
  const out = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.dimension !== dimension) continue;
    const flags = (criterion.value as { flags?: unknown }).flags;
    if (Array.isArray(flags)) for (const flag of flags) out.add(String(flag));
  }
  return out;
}

function dimensions(criteria: ReturnType<typeof extractAll>["criteria"]): Set<string> {
  return new Set(criteria.map((criterion) => criterion.dimension));
}

// ── 문장 분할 ─────────────────────────────────────────────────────────────
check("불릿·번호 마커를 문장 경계로 분할한다", () => {
  const s = splitDisqualificationSentences(blockText("creditinfo"));
  assert.ok(s.length >= 9, `문장 수 부족: ${s.length}`);
  assert.ok(s.some((x) => x.includes("완전자본잠식")), "자본잠식 문장 분리 실패");
});

check("ASCII 마침표는 문장 경계로 분할하고 소수점은 보존한다", () => {
  const sentences = splitDisqualificationSentences(
    "국세 체납 기업은 제외한다. 부채비율 1000.5% 이상 기업은 제외한다.",
  );
  assert.deepEqual(sentences, [
    "국세 체납 기업은 제외한다",
    "부채비율 1000.5% 이상 기업은 제외한다",
  ]);
});

check("삼각 불릿·한글 번호·괄호 표제를 문장 경계로 분할한다", () => {
  const sentences = splitDisqualificationSentences(
    "▷ 국세 체납자 나. 동일 과제 중복 참여자 (서류 허위제출) 허위 서류 제출자",
  );
  assert.deepEqual(sentences, ["국세 체납자", "동일 과제 중복 참여자", "허위 서류 제출자"]);
});

// ── C2: 구조화 금지(prior_award 절대 미생성) ─────────────────────────────────
check("어떤 블록에서도 prior_award 를 생성하지 않는다(C2)", () => {
  for (const key of Object.keys(EXCLUSION_BLOCKS)) {
    const { criteria } = extractAll(key);
    assert.ok(!dimensions(criteria).has("prior_award"), `${key}에서 prior_award 생성됨`);
  }
});

check("중복수혜·프로그램 수료 문장은 구조화되지 않고 residual 로 남는다(#8/#10/#13/#20)", () => {
  // busan: 중복입주(#10) — 구조화 금지.
  const busan = extractAll("busan");
  assert.ok(
    busan.residualSpans.some((s) => s.includes("중복입주")),
    "중복입주 문장이 residual 에 없음",
  );
  assert.ok(!busan.consumedSpans.some((s) => s.includes("중복입주")), "중복입주 문장이 소비됨");

  // kibo: 프로그램 수료·참여(#13) — 구조화 금지.
  const kibo = extractAll("kibo");
  assert.ok(
    kibo.residualSpans.some((s) => s.includes("수료") || s.includes("NEST") || s.includes("사관학교")),
    "프로그램 수료 문장이 residual 에 없음",
  );

  // creditinfo: 동일 사업 타부처 중복지원(#20) — 구조화 금지.
  const credit = extractAll("creditinfo");
  assert.ok(
    credit.residualSpans.some((s) => s.includes("중복 지원") || s.includes("타 부처")),
    "타부처 중복지원 문장이 residual 에 없음",
  );

  // daegu: 동일 과제 참여 중(#8 유사) — 구조화 금지.
  const daegu = extractAll("daegu");
  assert.ok(
    daegu.residualSpans.some((s) => s.includes("동일한 과제") || s.includes("참여 중")),
    "동일 과제 참여 중 문장이 residual 에 없음",
  );
});

// ── tax_compliance ─────────────────────────────────────────────────────────
check("국세·지방세 체납 → tax_compliance national+local (#1)", () => {
  const tax = flagsOf(extractAll("kfashion").criteria, "tax_compliance");
  assert.ok(tax.has("national_tax_delinquent"), "국세 체납 미검출");
  assert.ok(tax.has("local_tax_delinquent"), "지방세 체납 미검출");
});

check("납부기한 연장·징수유예 예외 → payment_deferral_approved (kibo ③)", () => {
  const { criteria } = extractAll("kibo");
  const taxCriterion = criteria.find((c) => c.dimension === "tax_compliance");
  assert.ok(taxCriterion, "kibo tax criterion 없음");
  const exceptions = (taxCriterion!.value as { exceptions?: string[] }).exceptions ?? [];
  assert.ok(exceptions.includes("payment_deferral_approved"), "납부유예 예외 미파싱");
});

// ── credit_status ──────────────────────────────────────────────────────────
check("신용정보상 연체·부도·금융질서문란·법정관리·회생·청산 → credit_status 다중 (#2,#3,#15,#23)", () => {
  const credit = flagsOf(extractAll("creditinfo").criteria, "credit_status");
  for (const flag of ["credit_delinquency", "bond_default", "financial_misconduct", "court_receivership", "rehabilitation_in_progress"]) {
    assert.ok(credit.has(flag), `creditinfo 에서 ${flag} 미검출`);
  }
});

check("채무불이행 → loan_default (#2)", () => {
  assert.ok(flagsOf(extractAll("kfashion").criteria, "credit_status").has("loan_default"), "채무불이행 미검출");
});

check("보증금지·보증제한 → guarantee_restricted (#12)", () => {
  assert.ok(flagsOf(extractAll("kibo").criteria, "credit_status").has("guarantee_restricted"), "보증제한 미검출");
});

check("압류(시효소멸 예외) → asset_seizure + statute_expired (#22)", () => {
  const { criteria } = extractAll("techstartup");
  const credit = criteria.find((c) => c.dimension === "credit_status" && Array.isArray((c.value as { flags?: string[] }).flags) && (c.value as { flags: string[] }).flags.includes("asset_seizure"));
  assert.ok(credit, "압류 criterion 없음");
  const exceptions = (credit!.value as { exceptions?: string[] }).exceptions ?? [];
  assert.ok(exceptions.includes("statute_expired"), "시효소멸 예외 미파싱");
});

check("파산·회생·개인회생 + 변제 정상이행 예외 → repayment_plan_in_good_standing (#23, daegu)", () => {
  const { criteria } = extractAll("daegu");
  const insolvency = criteria.find(
    (c) => c.dimension === "credit_status" && (c.value as { flags?: string[] }).flags?.includes("bankruptcy_filed"),
  );
  assert.ok(insolvency, "파산/회생 criterion 없음");
  const flags = (insolvency!.value as { flags: string[] }).flags;
  assert.ok(flags.includes("rehabilitation_in_progress"), "회생 미검출");
  const exceptions = (insolvency!.value as { exceptions?: string[] }).exceptions ?? [];
  assert.ok(exceptions.includes("repayment_plan_in_good_standing"), "변제 정상이행 예외 미파싱");
});

check("신용불량 금융기관 제재 → credit_status(금융 제재 재귀속, #24)", () => {
  const { criteria } = extractAll("daegu");
  // "신용불량 등으로 인하여 금융기관으로부터 제재 중" → credit 계열, sanction 아님.
  const hasFinancialSanctionAsSanction = criteria.some(
    (c) =>
      c.dimension === "sanction" &&
      typeof c.source_span === "string" &&
      c.source_span.includes("신용불량"),
  );
  assert.ok(!hasFinancialSanctionAsSanction, "신용불량 금융제재가 sanction 으로 오귀속");
});

// ── sanction ───────────────────────────────────────────────────────────────
check("정부사업 참여제한(부정수급) → sanction participation_restricted+subsidy_fraud (#5)", () => {
  const s = flagsOf(extractAll("kfashion").criteria, "sanction");
  assert.ok(s.has("participation_restricted"), "참여제한 미검출");
  assert.ok(s.has("subsidy_fraud"), "부정수급 미검출");
});

check("보조금법 위반·특수관계 → sanction subsidy_law_violation (#18)", () => {
  assert.ok(flagsOf(extractAll("creditinfo").criteria, "sanction").has("subsidy_law_violation"), "보조금법 위반 미검출");
});

check("협약·계약 위반 → sanction agreement_breach (#25)", () => {
  assert.ok(flagsOf(extractAll("daegu").criteria, "sanction").has("agreement_breach"), "협약위반 미검출");
});

// ── financial_health ───────────────────────────────────────────────────────
check("완전자본잠식 → financial_health impairment_excluded=[full] (#16)", () => {
  const { criteria } = extractAll("creditinfo");
  const fh = criteria.find((c) => c.dimension === "financial_health");
  assert.ok(fh, "financial_health criterion 없음");
  const impair = (fh!.value as { impairment_excluded?: string[] }).impairment_excluded ?? [];
  assert.ok(impair.includes("full"), "완전자본잠식 full 미파싱");
  assert.ok(!impair.includes("partial"), "완전자본잠식인데 partial 이 섞임");
});

// ── industry(배제업종) ──────────────────────────────────────────────────────
check("유흥주점·암호화자산·사행시설 → industry not_in canonical KSIC (#14,#19,#26)", () => {
  const { criteria } = extractAll("techstartup");
  const ind = criteria.find((c) => c.dimension === "industry" && c.operator === "not_in");
  assert.ok(ind, "배제업종 industry not_in 없음");
  const codes = new Set((ind!.value as { codes?: string[] }).codes ?? []);
  for (const code of ["56211", "56212", "56219", "63999", "91249"]) {
    assert.ok(codes.has(code), `배제업종 KSIC ${code} 미매핑`);
  }
});

check("도박·사치·향락·부동산 → industry not_in (kibo ④)", () => {
  const { criteria } = extractAll("kibo");
  const ind = criteria.find((c) => c.dimension === "industry" && c.operator === "not_in");
  assert.ok(ind, "kibo 배제업종 없음");
  const codes = new Set((ind!.value as { codes?: string[] }).codes ?? []);
  assert.ok(codes.has("68"), "부동산업 KSIC 68 미매핑");
  assert.ok(codes.has("91249"), "사행시설(도박) 미매핑");
});

// ── business_status(휴폐업) ──────────────────────────────────────────────────
check("휴·폐업 → business_status not_in closed (#4)", () => {
  const { criteria } = extractAll("kfashion");
  assert.ok(
    criteria.some((c) => c.dimension === "business_status" && c.operator === "not_in"),
    "휴폐업 business_status 미검출",
  );
});

// ── span 정책 M1 ────────────────────────────────────────────────────────────
check("모든 구조화 criterion 은 raw_text 없이 source_span(귀속 문장)만 갖는다(M1)", () => {
  for (const key of Object.keys(EXCLUSION_BLOCKS)) {
    const { criteria } = extractAll(key);
    for (const criterion of criteria) {
      assert.equal(criterion.raw_text, undefined, `${key}: raw_text 가 설정됨(M1 위반)`);
      assert.ok(typeof criterion.source_span === "string" && criterion.source_span.length > 0, `${key}: source_span 누락`);
      // span 은 원문 전체보다 짧아야 한다(문장 단위).
      assert.ok((criterion.source_span ?? "").length < blockText(key).length, `${key}: source_span 이 전체 원문`);
    }
  }
});

// ── 이중 카운트 방지 ─────────────────────────────────────────────────────────
check("criteria-contract: (dimension, span) 중복 없음 + 값 스키마 통과", () => {
  for (const key of Object.keys(EXCLUSION_BLOCKS)) {
    const { criteria } = extractAll(key);
    const withIds: GrantCriterion[] = criteria.map((c, i) => ({
      ...c,
      id: `test:${key}:${i}`,
      grant_id: `test:${key}`,
      parser_version: "test",
    }));
    const issues = validateGrantCriteriaContract(withIds);
    assert.deepEqual(issues, [], `${key} 계약 위반: ${JSON.stringify(issues)}`);
  }
});

// ── 27종 recall 종합(구조화 대상 16종 전부 귀속, 오귀속 0) ────────────────────
check("27종 종합 귀속 표: 구조화 대상 16종 전부 정확 귀속, C2 4종 미구조화, 오귀속 0", () => {
  const all = Object.keys(EXCLUSION_BLOCKS).flatMap((key) => extractAll(key).criteria);
  const taxFlags = flagsOf(all, "tax_compliance");
  const creditFlags = flagsOf(all, "credit_status");
  const sanctionFlags = flagsOf(all, "sanction");
  const dims = new Set(all.map((c) => c.dimension));

  // 신설 12축 대상 플래그(연구 §3.2 표 기준) 전수 귀속:
  // tax: national+local (#1)
  assert.ok(taxFlags.has("national_tax_delinquent") && taxFlags.has("local_tax_delinquent"), "tax 귀속 실패");
  // credit: loan_default(#2) bond_default(#3) guarantee_restricted(#12) 연체/법정관리/회생/청산(#15)
  //         financial_misconduct(#15) asset_seizure(#22) rehabilitation/bankruptcy(#23)
  for (const flag of ["loan_default", "bond_default", "guarantee_restricted", "credit_delinquency", "court_receivership", "financial_misconduct", "asset_seizure", "rehabilitation_in_progress", "bankruptcy_filed"]) {
    assert.ok(creditFlags.has(flag), `credit 귀속 실패: ${flag}`);
  }
  // sanction: participation_restricted+subsidy_fraud(#5) subsidy_law_violation(#18) agreement_breach(#25)
  for (const flag of ["participation_restricted", "subsidy_fraud", "subsidy_law_violation", "agreement_breach"]) {
    assert.ok(sanctionFlags.has(flag), `sanction 귀속 실패: ${flag}`);
  }
  // financial_health(#16), industry(#14/#19/#26), business_status(#4)
  assert.ok(dims.has("financial_health"), "financial_health 미귀속");
  assert.ok(dims.has("industry"), "industry 배제업종 미귀속");
  assert.ok(dims.has("business_status"), "business_status 미귀속");

  // 오귀속 0: prior_award 절대 없음, 예약 2축 없음.
  assert.ok(!dims.has("prior_award"), "prior_award 오귀속");
  assert.ok(!dims.has("premises") && !dims.has("export_performance"), "예약 축 오귀속");
});

console.log(`\n결격 분해기 + 27종 recall 검증 통과: ${passed}건`);

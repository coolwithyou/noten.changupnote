/**
 * 인증(certification) 축 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/certification/certs.test.ts
 *
 * 커버: 사전 무결성, canonicalizeCert/certsMatch(예비사회적기업 분리 포함),
 *       normalize 분류(긍정→required / 우대→preferred / 제외→placeholder / 특허·연구소시설→placeholder /
 *       느슨한 나열→placeholder), match canonical 매칭(회사 확인서 표기 vs 공고 canonical), 하위호환 키.
 */
import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import {
  CANONICAL_CERTS,
  CERT_RULES,
  canonicalizeCert,
  certsMatch,
  extractCerts,
} from "./certs.js";
import { buildKStartupCriteria, classifyKStartupCertification } from "../kstartup/normalize.js";
import { matchGrantCriteria } from "../matching/match.js";
import type { KStartupAnnouncement } from "../kstartup/types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. 사전 무결성 ─────────────────────────────────────────────
check("CERT_RULES 의 canonical 이 모두 CANONICAL_CERTS 에 등재돼 있다", () => {
  const set = new Set<string>(CANONICAL_CERTS);
  for (const rule of CERT_RULES) assert.ok(set.has(rule.canonical), `미등재 canonical: ${rule.canonical}`);
});

check("canonicalizeCert: 별칭/확인서 표기를 canonical 로 수렴, 미등재는 null", () => {
  assert.equal(canonicalizeCert("벤처기업확인서"), "벤처기업");
  assert.equal(canonicalizeCert("여성기업확인서"), "여성기업");
  assert.equal(canonicalizeCert("장애인기업확인서"), "장애인기업");
  assert.equal(canonicalizeCert("INNO-BIZ"), "이노비즈");
  assert.equal(canonicalizeCert("ISO 9001 인증"), "ISO9001");
  assert.equal(canonicalizeCert("특허 보유"), null); // IP 는 인증 사전 대상 아님
  assert.equal(canonicalizeCert("연구소 이전"), null); // "부설" 없는 맨 연구소는 시설 언급
});

check("예비사회적기업은 사회적기업과 별도 canonical 로 분리된다", () => {
  assert.deepEqual(extractCerts("예비사회적기업"), ["예비사회적기업"]);
  assert.deepEqual(extractCerts("사회적기업"), ["사회적기업"]);
  assert.deepEqual(extractCerts("(예비)사회적기업"), ["예비사회적기업"]);
});

// ── 2. certsMatch canonical 매칭 4케이스 ───────────────────────
check("certsMatch 4케이스(회사 확인서 표기 vs 공고 canonical)", () => {
  // (1) 회사 "여성기업확인서"(SMPP) vs 공고 "여성기업" → 매칭
  assert.equal(certsMatch(["여성기업확인서"], ["여성기업"]), true);
  // (2) 회사 자유텍스트 "벤처기업, 이노비즈" vs 공고 "이노비즈" → 매칭
  assert.equal(certsMatch(["벤처기업, 이노비즈"], ["이노비즈"]), true);
  // (3) 다른 인증은 비매칭: 회사 장애인 vs 공고 여성
  assert.equal(certsMatch(["장애인기업확인서"], ["여성기업"]), false);
  // (4) 요구 인증 canonical 이 하나도 없으면 false
  assert.equal(certsMatch(["벤처기업"], ["특허"]), false);
});

// ── 3. normalize 분류 ─────────────────────────────────────────
function kstartupRow(aplyTrgt: string, aplyExcl?: string): KStartupAnnouncement {
  return {
    pbanc_sn: 1,
    aply_trgt_ctnt: aplyTrgt,
    aply_excl_trgt_ctnt: aplyExcl,
  } as unknown as KStartupAnnouncement;
}
function certOf(row: KStartupAnnouncement) {
  return buildKStartupCriteria(row).find((c) => c.dimension === "certification");
}

check("긍정 보유요건 '벤처기업 확인서를 보유한 기업' → required, certs ['벤처기업']", () => {
  const cert = certOf(kstartupRow("벤처기업 확인서를 보유한 기업 모집"));
  assert.ok(cert);
  assert.equal(cert.operator, "in");
  assert.equal(cert.kind, "required");
  assert.equal(cert.confidence, 0.6);
  assert.equal(cert.needs_review, true);
  assert.deepEqual((cert.value as { certs: string[] }).certs, ["벤처기업"]);
});

check("'기업부설연구소 보유 기업' → required ['기업부설연구소'] (맨 연구소 아님)", () => {
  const cert = certOf(kstartupRow("기업부설연구소 보유 기업"));
  assert.ok(cert);
  assert.equal(cert.kind, "required");
  assert.deepEqual((cert.value as { certs: string[] }).certs, ["기업부설연구소"]);
});

check("우대·가점 '중소·벤처기업 우대' → preferred (하드 탈락 없음)", () => {
  const cert = certOf(kstartupRow("대한민국 모든 산업 분야 기업(스타트업 및 중소·벤처기업 우대)"));
  assert.ok(cert);
  assert.equal(cert.operator, "in");
  assert.equal(cert.kind, "preferred");
  assert.deepEqual((cert.value as { certs: string[] }).certs, ["벤처기업"]);
});

check("제외 문맥 '벤처기업 확인서 미보유 기업은 제외' → placeholder(text_only)", () => {
  const cert = certOf(kstartupRow("창업기업 모집\n- 벤처기업 확인서 미보유 기업은 제외"));
  assert.ok(cert);
  assert.equal(cert.operator, "text_only");
});

check("특허(IP)만 언급 → placeholder(text_only), required 아님", () => {
  const cert = certOf(kstartupRow("특허를 보유한 창업기업"));
  assert.ok(cert);
  assert.equal(cert.operator, "text_only");
});

check("연구소 시설 언급(본사·지사·연구소) → placeholder(text_only)", () => {
  const cert = certOf(kstartupRow("서울 창업기업\n- 본사, 지사, 연구소 中 택일하여 이전 가능한 기업"));
  assert.ok(cert);
  assert.equal(cert.operator, "text_only");
});

check("느슨한 나열 '벤처기업 등' → placeholder(하드 required 금지)", () => {
  const cert = certOf(kstartupRow("ESG 주제에 관심있는 (예비)창업자, 벤처기업 등"));
  assert.ok(cert);
  assert.equal(cert.operator, "text_only");
});

check("인증 힌트 없으면 certification criterion 자체가 없다", () => {
  const cert = certOf(kstartupRow("서울 소재 창업 3년 이내 기업"));
  assert.equal(cert, undefined);
});

check("classifyKStartupCertification: placeholder 인데 매치되면 matchedCert 를 노출(진단)", () => {
  const c = classifyKStartupCertification(kstartupRow("예비창업가, 벤처기업 등 누구나"));
  assert.equal(c.outcome, "placeholder");
  assert.equal(c.matchedCert, "벤처기업");
});

// ── 4. match canonical 매칭 & 하위호환 ─────────────────────────
const ventureCompany: CompanyProfile = {
  certs: ["여성기업확인서"],
  confidence: { certification: 0.9 },
};

check("required {certs:['여성기업']} vs 회사 ['여성기업확인서'] → pass/eligible", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "certification",
    operator: "in",
    kind: "required",
    value: { certs: ["여성기업"], certifications: ["여성기업"], labels: ["여성기업"] },
    confidence: 0.6,
  }];
  const result = matchGrantCriteria(criteria, ventureCompany);
  assert.equal(result.rule_trace[0]?.result, "pass");
  assert.equal(result.eligibility, "eligible");
});

check("하위호환: 기존 {certifications:['벤처기업']} 키도 canonical 매칭한다", () => {
  const company: CompanyProfile = { certs: ["벤처기업, 이노비즈"], confidence: { certification: 0.9 } };
  const criteria: GrantCriterion[] = [{
    dimension: "certification",
    operator: "in",
    kind: "required",
    value: { certifications: ["벤처기업"] },
    confidence: 0.9,
  }];
  assert.equal(matchGrantCriteria(criteria, company).rule_trace[0]?.result, "pass");
});

check("preferred fail 은 하드 탈락을 만들지 않는다(eligible 유지)", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "certification",
    operator: "in",
    kind: "preferred",
    value: { certs: ["메인비즈"] },
    confidence: 0.6,
  }];
  const result = matchGrantCriteria(criteria, ventureCompany);
  assert.equal(result.rule_trace[0]?.result, "fail");
  assert.equal(result.eligibility, "eligible");
});

check("보유 인증 미입력이면 known 여부로 fail/unknown 을 가른다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "certification",
    operator: "in",
    kind: "required",
    value: { certs: ["벤처기업"] },
    confidence: 0.6,
  }];
  const known: CompanyProfile = { certs: [], confidence: { certification: 0.9 } };
  const unknown: CompanyProfile = { certs: [] };
  assert.equal(matchGrantCriteria(criteria, known).rule_trace[0]?.result, "fail");
  assert.equal(matchGrantCriteria(criteria, unknown).rule_trace[0]?.result, "unknown");
});

console.log(`\ncerts.test.ts: ${passed} checks passed.`);

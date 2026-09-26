import assert from "node:assert/strict";
import { sealDeepAnalysisInput, type DeepAnalysisInputAttachment } from "@/lib/server/deep-analysis/inputManifest";
import { sha256Hex, stableJson } from "@/lib/server/deep-analysis/sourceRevision";
import { buildDiscoverySourceEvidence } from "./discoverySourceEvidence";

const company = {
  biz_age_months: 29,
  target_types: ["개인사업자"],
  industries: ["응용 소프트웨어 개발 및 공급업", "광고 대행업"],
};

function attachment(id: string, filename: string, markdownText: string): DeepAnalysisInputAttachment {
  return {
    id, filename, sourceUri: `https://www.k-startup.go.kr/attachment/${id}`,
    contentType: "application/octet-stream", bytes: 100,
    storageKey: `archive/${id}`, sha256: sha256Hex(id),
    conversionStatus: "converted", markdownStorageKey: `markdown/${id}`,
    markdownSha256: sha256Hex(markdownText), markdownText,
  };
}

function seal(rawPayload: Record<string, unknown>, attachments: DeepAnalysisInputAttachment[] = [], grantUrl: string | null = "https://www.k-startup.go.kr/notice") {
  return sealDeepAnalysisInput({
    grantId: "grant-1", sourceRevisionSha256: sha256Hex("current-source"),
    structuredText: stableJson({ schema: "deep-analysis-structured-source-v1",
      grant: { url: grantUrl }, rawPayload }),
    attachments,
  });
}

const seongsu = buildDiscoverySourceEvidence(seal({
  aply_trgt_ctnt: "모집공고일(2026.9.3.) 기준, 창업 후 7년 미만의 스타트업(*신산업의 경우 창업 10년 이내 기업도 가능)\n- 신청일 기준 사업자 등록이 완료된 기업만 신청 가능",
  aply_excl_trgt_ctnt: "모집 공고문 참고",
}, [attachment("seongsu-notice", "[공고문] 서울창업허브 성수 입주기업 모집.hwp", [
  "□ 모집대상 및 신청자격",
  "① 모집공고일 기준 창업 7년 이내 창업기업, 신산업 창업 분야는 창업 10년 이내 창업기업",
  "② 입주 계약 체결 이후 30일 이내 본점 또는 지점 주소지 이전등록이 가능한 창업기업",
  "□ 신청 제외대상",
  "④ 서울시 창업공간 입주 지원사업 수혜 중인 기업. 단, 입주계약 이전에 종료하면 신청 가능",
  "⑧ 서울시 7대 창업거점시설 사무공간 입주수혜 이력이 있는 기업",
].join("\n"))]), company, null);
assert.ok(seongsu);
assert.equal(seongsu.companyFacts.bizAgeMonths, 29);
assert.ok(seongsu.excerpts.some((excerpt) => excerpt.kind === "attachment_target" && excerpt.text.includes("30일 이내")));
assert.ok(seongsu.excerpts.some((excerpt) => excerpt.kind === "attachment_exclusion" && excerpt.text.includes("입주수혜 이력")));
assert.equal(seongsu.exclusionDetailsUnavailable, false);
assert.ok(seongsu.reviewItems.some((item) => item.label.includes("주소지 이전")));
assert.ok(seongsu.reviewItems.some((item) => item.label.includes("입주 지원 수혜")));

const rocketship = buildDiscoverySourceEvidence(seal({
  aply_trgt_ctnt: "운영사무국은 스타트업의 투자유치와 네트워크 확장을 지원하기 위해 경진대회를 개최합니다.",
  aply_excl_trgt_ctnt: null,
}, [
  attachment("form", "[붙임1] 참가신청서.hwp", "신청자격\n사업자등록 완료 여부\n신청기업명"),
  attachment("notice", "[공고문] 로켓십 IR 참가기업 모집.pdf", [
    "□ 신청 자격: ‘23년~’26년 초기창업패키지 선정·졸업기업",
    "□ 신청(지원) 제외 대상",
    "§ 창업에서 제외되는 업종",
  ].join("\n")),
]), company, null);
assert.ok(rocketship);
assert.equal(rocketship.excerpts.some((excerpt) => excerpt.text.includes("운영사무국은")), false,
  "소개 문장을 모집 자격으로 제시하지 않는다");
assert.equal(rocketship.excerpts.some((excerpt) => excerpt.sourceLabel.includes("참가신청서")), false,
  "신청서 양식의 칸을 공식 자격 조항으로 제시하지 않는다");
assert.ok(rocketship.excerpts.some((excerpt) => excerpt.text.includes("선정·졸업기업")));
assert.ok(rocketship.reviewItems.some((item) => item.label.includes("선정·졸업 이력")));

const incomplete = buildDiscoverySourceEvidence(seal({
  aply_trgt_ctnt: "전국 소재 예비창업자 및 7년 이내 창업기업", aply_excl_trgt_ctnt: null,
}, [attachment("unavailable", "공고문.pdf", "원문")].map((item) => ({
  ...item, storageKey: null, sha256: null, markdownText: null,
}))), company, null);
assert.ok(incomplete);
assert.equal(incomplete.incompleteAttachments, true);
assert.equal(incomplete.exclusionDetailsUnavailable, true);
assert.equal(incomplete.excerpts.some((excerpt) => excerpt.kind === "attachment_target"), false);

assert.equal(buildDiscoverySourceEvidence(seal({}), company, null), null,
  "자격 원문이 없으면 회사 정보만으로 검토 근거를 만든 것으로 보이지 않는다");
assert.equal(buildDiscoverySourceEvidence(seal({ aply_trgt_ctnt: "7년 이내 창업기업" }, [], null), company, "javascript:alert(1)"), null,
  "외부 링크가 안전하지 않고 대체 원문 링크도 없을 때 근거를 보여주지 않는다");
console.log("discovery source evidence: official clauses, form exclusion, missing source safeguards passed");

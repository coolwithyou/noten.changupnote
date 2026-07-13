import assert from "node:assert/strict";
import type { Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import {
  assessGrantPair,
  collapseConfirmedGrantOccurrences,
  findGrantDedupCandidates,
} from "./grant-dedup.js";

const base = grant({
  source_id: "K-100",
  title: "2026년 스타트업 테크 브릿지 참여기업 모집공고",
  agency_operator: "창업진흥원",
  apply_start: "2026-06-01",
  apply_end: "2026-07-31",
  url: "https://example.go.kr/notice/100?utm_source=portal",
});

const exact = assessGrantPair(base, grant({
  source_id: "B-100",
  title: "2026년 스타트업 테크 브릿지 참여기업 모집공고",
  agency_operator: "창업진흥원",
  apply_start: "2026-06-01",
  apply_end: "2026-07-31",
}));
assert.equal(exact.decision, "auto_duplicate");
assert.equal(exact.relation, "same_announcement");
assert.equal(exact.signals.exactNormalizedTitle, true);

const sameUrl = assessGrantPair(base, grant({
  source_id: "B-URL",
  title: "스타트업 테크브릿지 지원대상 안내",
  url: "https://example.go.kr/notice/100#application",
}));
assert.equal(sameUrl.signals.exactCanonicalUrl, true);
assert.equal(sameUrl.decision, "auto_duplicate");

const differentYear = assessGrantPair(base, grant({
  source_id: "B-2025",
  title: "2025년 스타트업 테크 브릿지 참여기업 모집공고",
  agency_operator: "창업진흥원",
  apply_start: "2025-06-01",
  apply_end: "2025-07-31",
}));
assert.equal(differentYear.decision, "review");
assert.equal(differentYear.relation, "reannouncement");
assert.equal(differentYear.signals.yearConflict, true);

const differentRound = assessGrantPair(
  grant({ ...base, title: "2026년 테크 브릿지 1차 참여기업 모집" }),
  grant({ ...base, source_id: "B-ROUND", title: "2026년 테크 브릿지 2차 참여기업 모집" }),
);
assert.equal(differentRound.decision, "review");
assert.equal(differentRound.signals.roundConflict, true);

const titleOnly = assessGrantPair(
  grant({ source_id: "K-TITLE", title: "지역혁신 지원사업" }),
  grant({ source_id: "B-TITLE", title: "지역혁신 지원사업" }),
);
assert.equal(titleOnly.decision, "distinct", "범용 제목만 같으면 자동 병합하지 않는다");

const unrelated = assessGrantPair(base, grant({
  source_id: "B-OTHER",
  title: "소상공인 전통시장 시설개선 융자",
  agency_operator: "소상공인시장진흥공단",
}));
assert.equal(unrelated.decision, "distinct");

const requiredRegion: GrantCriterion = {
  dimension: "region",
  kind: "required",
  operator: "in",
  value: { regions: ["11"] },
  confidence: 1,
  source_field: "target",
  source_span: "서울 소재 기업",
};
const qualityCanonical = findGrantDedupCandidates([
  normalized("kstartup", "K-QUALITY", "동일 품질선택 공고", [], null),
  normalized("bizinfo", "B-QUALITY", "동일 품질선택 공고", [requiredRegion], "https://example.go.kr/quality"),
]);
assert.equal(qualityCanonical[0]?.canonicalGrantKey, "bizinfo:B-QUALITY");
assert.equal(qualityCanonical[0]?.memberGrantKey, "kstartup:K-QUALITY");

const lowScoreAutoLeft = normalized("kstartup", "K-LOW", "정확 제목 저점수 공고", [], null);
const lowScoreAutoRight = normalized("bizinfo", "B-LOW", "정확 제목 저점수 공고", [], null);
lowScoreAutoLeft.grant.agency_operator = null;
lowScoreAutoRight.grant.agency_operator = null;
const lowScoreAuto = findGrantDedupCandidates([lowScoreAutoLeft, lowScoreAutoRight]);
assert.equal(lowScoreAuto[0]?.score, 0.8);
assert.equal(lowScoreAuto[0]?.decision, "auto_duplicate", "강한 동일성 근거는 일반 score cutoff 아래에서도 보존한다");

const canonicalOccurrence = normalized("bizinfo", "B-MERGE", "병합 공고", [requiredRegion], "https://example.go.kr/merge");
canonicalOccurrence.grant.id = "00000000-0000-4000-8000-000000000301";
canonicalOccurrence.grant.apply_start = "2026-07-05";
canonicalOccurrence.grant.apply_end = "2026-07-20";
canonicalOccurrence.grant.f_industries = ["소프트웨어"];
const extendedOccurrence = normalized("kstartup", "K-MERGE", "병합 공고", [], null);
extendedOccurrence.grant.id = "00000000-0000-4000-8000-000000000302";
extendedOccurrence.grant.apply_start = "2026-07-01";
extendedOccurrence.grant.apply_end = "2026-07-31";
extendedOccurrence.grant.f_regions = ["11"];
const collapsed = collapseConfirmedGrantOccurrences([canonicalOccurrence, extendedOccurrence], [{
  canonicalGrantKey: canonicalOccurrence.grant.id,
  memberGrantKey: extendedOccurrence.grant.id,
}]);
assert.equal(collapsed.length, 1);
assert.equal(collapsed[0]?.grant.id, canonicalOccurrence.grant.id, "confirmed canonical identity를 유지한다");
assert.equal(collapsed[0]?.grant.apply_start, "2026-07-01", "가장 이른 접수 시작일을 보존한다");
assert.equal(collapsed[0]?.grant.apply_end, "2026-07-31", "연장된 최신 마감일을 보존한다");
assert.deepEqual(collapsed[0]?.grant.f_regions, ["11"]);
assert.deepEqual(collapsed[0]?.grant.f_industries, ["소프트웨어"]);
assert.equal(collapsed[0]?.criteria.length, 1, "canonical의 더 완전한 criterion을 유지한다");

console.log("grant-dedup-assessment: ok");

function grant(input: Partial<Grant> & Pick<Grant, "source_id" | "title">): Grant {
  return {
    source: "bizinfo",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
    ...input,
  };
}

function normalized(
  source: Grant["source"],
  sourceId: string,
  title: string,
  criteria: GrantCriterion[],
  url: string | null,
): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: { source, source_id: sourceId, payload: {}, status: "normalized" },
    grant: grant({
      source,
      source_id: sourceId,
      title,
      url,
      agency_operator: "동일기관",
      apply_start: "2026-07-01",
      apply_end: "2026-07-31",
    }),
    criteria,
  };
}

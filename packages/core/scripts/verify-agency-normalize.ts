import assert from "node:assert/strict";
import { normalizeAgencyName, resolveGrantAgencyPrimary } from "../src/index.js";

// ── normalizeAgencyName ──────────────────────────────────────────────────────

// 확인된 안전 규칙: "장관" 제거(공백 유무 무관).
assert.equal(normalizeAgencyName("중소벤처기업부 장관"), "중소벤처기업부");
assert.equal(normalizeAgencyName("중소벤처기업부장관"), "중소벤처기업부");

// 빈값/플레이스홀더 → null.
assert.equal(normalizeAgencyName(null), null);
assert.equal(normalizeAgencyName(undefined), null);
assert.equal(normalizeAgencyName(""), null);
assert.equal(normalizeAgencyName("   "), null);
assert.equal(normalizeAgencyName("-"), null);
assert.equal(normalizeAgencyName("–"), null);
assert.equal(normalizeAgencyName("."), null);
assert.equal(normalizeAgencyName("없음"), null);
assert.equal(normalizeAgencyName("해당없음"), null);
assert.equal(normalizeAgencyName("N/A"), null);

// 과잉 제거 방지: "창업진흥원장"은 "창업진흥"으로 뭉개지지 않고 "창업진흥원"(원)으로만 정규화된다.
assert.equal(normalizeAgencyName("창업진흥원장"), "창업진흥원");
assert.notEqual(normalizeAgencyName("창업진흥원장"), "창업진흥");
assert.equal(normalizeAgencyName("경기도경제과학진흥원장"), "경기도경제과학진흥원");

// 단일 "장" 제거는 기관형 어미(원·청·시)로 끝날 때만.
assert.equal(normalizeAgencyName("특허청장"), "특허청");
assert.equal(normalizeAgencyName("동작구청장"), "동작구청");
assert.equal(normalizeAgencyName("서울특별시 관악구청장"), "서울특별시 관악구청");
assert.equal(normalizeAgencyName("서울특별시장"), "서울특별시");
assert.equal(normalizeAgencyName("의왕시장"), "의왕시");

// 기관형 어미가 아니면 미제거(보수적). "센터장"은 그대로 둔다.
assert.equal(normalizeAgencyName("㈜오퍼스이앤씨 센터장"), "오퍼스이앤씨 센터장");
assert.equal(normalizeAgencyName("신용보증기금 이사장"), "신용보증기금 이사장");

// 도지사 → 도(결과가 "도"로 끝날 때만). 회사 지사("…지사")는 보존.
assert.equal(normalizeAgencyName("경기도지사"), "경기도");
assert.equal(normalizeAgencyName("충청남도지사"), "충청남도");
assert.equal(normalizeAgencyName("(주)크립톤 전북지사"), "크립톤 전북지사");

// 군수 → 군(결과가 "군"으로 끝날 때만).
assert.equal(normalizeAgencyName("양평군수"), "양평군");

// 법인격 접두 제거 — 동일 기관을 하나로 모은다.
assert.equal(normalizeAgencyName("(재)대전창조경제혁신센터"), "대전창조경제혁신센터");
assert.equal(normalizeAgencyName("(주)오픈놀"), "오픈놀");
assert.equal(normalizeAgencyName("㈜오피스허브"), "오피스허브");
assert.equal(normalizeAgencyName("주식회사 위티"), "위티");
assert.equal(normalizeAgencyName("재단법인 은행권청년창업재단"), "은행권청년창업재단");
assert.equal(normalizeAgencyName("(사)한국경제개발연구원"), "한국경제개발연구원");

// 접두 + 접미 동시("(재)…원장" → 접두 제거 후 원장 → 원).
assert.equal(normalizeAgencyName("(재)대전정보문화산업진흥원장"), "대전정보문화산업진흥원");

// 내부 공백 정리.
assert.equal(normalizeAgencyName("  서울경제진흥원  "), "서울경제진흥원");
assert.equal(normalizeAgencyName("경기도  경제과학진흥원"), "경기도 경제과학진흥원");

// 이미 정규형이면 그대로.
assert.equal(normalizeAgencyName("중소벤처기업부"), "중소벤처기업부");
assert.equal(normalizeAgencyName("서울경제진흥원"), "서울경제진흥원");

// ── resolveGrantAgencyPrimary ────────────────────────────────────────────────

// K-Startup: jurisdiction 사용, 정규화 적용.
assert.equal(
  resolveGrantAgencyPrimary({ source: "kstartup", jurisdiction: "중소벤처기업부 장관", operator: "창업지원팀" }),
  "중소벤처기업부",
);
// K-Startup: operator 는 담당 부서명이라 jurisdiction 이 없으면 폴백하지 않는다(null).
assert.equal(
  resolveGrantAgencyPrimary({ source: "kstartup", jurisdiction: "", operator: "창업지원팀" }),
  null,
);
assert.equal(
  resolveGrantAgencyPrimary({ source: "kstartup", jurisdiction: null, operator: "-" }),
  null,
);

// BizInfo: operator(수행기관) 우선.
assert.equal(
  resolveGrantAgencyPrimary({ source: "bizinfo", jurisdiction: "경상북도", operator: "경상북도경제진흥원" }),
  "경상북도경제진흥원",
);
// BizInfo: 비기관 operator("기초자치단체"/"직접수행") → jurisdiction 폴백.
assert.equal(
  resolveGrantAgencyPrimary({ source: "bizinfo", jurisdiction: "경기도", operator: "기초자치단체" }),
  "경기도",
);
assert.equal(
  resolveGrantAgencyPrimary({ source: "bizinfo", jurisdiction: "중소벤처기업부", operator: "직접수행" }),
  "중소벤처기업부",
);
// BizInfo: operator 가 비어도 jurisdiction 폴백.
assert.equal(
  resolveGrantAgencyPrimary({ source: "bizinfo", jurisdiction: "서울특별시", operator: null }),
  "서울특별시",
);
// bizinfo_event 도 bizinfo 와 동일 규칙.
assert.equal(
  resolveGrantAgencyPrimary({ source: "bizinfo_event", jurisdiction: "경기도", operator: "기초자치단체" }),
  "경기도",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "minister_suffix",
    "placeholders_to_null",
    "director_suffix_org_form_guard",
    "no_over_removal_changwoon",
    "governor_and_county_head",
    "branch_office_preserved",
    "legal_entity_prefix",
    "prefix_plus_suffix",
    "whitespace_collapse",
    "kstartup_uses_jurisdiction",
    "bizinfo_operator_priority",
    "bizinfo_non_agency_fallback",
  ],
}, null, 2));

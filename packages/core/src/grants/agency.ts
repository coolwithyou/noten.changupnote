import type { GrantSource } from "@cunote/contracts";

// 주관기관명(agency_primary) 정규화의 단일 원천.
// grants.agency_jurisdiction / agency_operator 는 출처마다 의미가 다르다:
//   - K-Startup: agency_jurisdiction = 주관기관명(pbanc_ntrp_nm, 예: "서울경제진흥원", "중소벤처기업부 장관"),
//                agency_operator     = 담당 부서명(예: "창업지원팀", "-") — 기관명이 아니다.
//   - BizInfo:   agency_jurisdiction = 소관부처/광역지자체(예: "중소벤처기업부", "경기도"),
//                agency_operator     = 수행기관명(예: "경상북도경제진흥원"). 단 "기초자치단체",
//                "직접수행" 같은 비(非)기관 값이 섞여 있어 그 경우 jurisdiction 으로 폴백한다.
// 목표: 출처와 무관하게 "이 공고를 주관하는 기관 이름" 하나를 정규화해 담는다.

// 빈값/플레이스홀더 — 기관명이 아니므로 null 로 본다. (latin 은 소문자 비교)
const PLACEHOLDER_VALUES = new Set([
  "-",
  "–",
  "—",
  ".",
  "·",
  "없음",
  "해당없음",
  "해당 없음",
  "미정",
  "n/a",
  "na",
  "null",
  "none",
]);

// 법인격 접두 — 기관 실체명 앞에 붙는 표기라 제거해 동일 기관을 하나로 모은다.
// 실데이터(kstartup)에서 확인: (재) 2262, (주) 760, (사) 438, 재단법인 416, 주식회사 416, ㈜ 317, 사단법인 136, (유) 31.
const LEGAL_ENTITY_PREFIXES = [
  "재단법인",
  "사단법인",
  "주식회사",
  "유한회사",
  "(재)",
  "(사)",
  "(주)",
  "(유)",
  "㈜",
  "㈔",
] as const;

// BizInfo agency_operator 에 섞인 비기관 값 — 이 경우 수행기관이 없다는 뜻이라 jurisdiction 으로 폴백한다.
// 실데이터(bizinfo)에서 확인: "기초자치단체" 145, "직접수행" 59.
const BIZINFO_NON_AGENCY_OPERATORS = new Set([
  "기초자치단체",
  "광역자치단체",
  "자치단체",
  "직접수행",
  "직접 수행",
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.toLowerCase());
}

function stripLegalEntityPrefix(value: string): string {
  for (const prefix of LEGAL_ENTITY_PREFIXES) {
    if (value.startsWith(prefix)) {
      // 접두 뒤에 이어지는 공백까지 함께 제거("재단법인 인천테크노파크" → "인천테크노파크").
      return value.slice(prefix.length).replace(/^\s+/, "");
    }
  }
  return value;
}

// 직함 접미 제거 — 보수적으로. 확인된 안전 규칙 + 과잉 제거 방지용 기관형 어미 가드.
function stripTitleSuffix(value: string): string {
  // 1. "장관" — 확인된 안전 규칙. "중소벤처기업부 장관"·"중소벤처기업부장관" → "중소벤처기업부".
  const withoutMinister = value.replace(/\s*장관$/, "");
  if (withoutMinister !== value) return withoutMinister.trimEnd();

  // 2. "테크노파크 원장"/"테크노파크원장" → "테크노파크". 일반 "장" 규칙(4번)만 적용하면
  //    "…테크노파크원"이 남아 "…테크노파크"와 갈라진다(테크노파크는 "원"으로 끝나는 기관이 아니다).
  const withoutTechnoparkDirector = value.replace(/(테크노파크)\s*원장$/, "$1");
  if (withoutTechnoparkDirector !== value) return withoutTechnoparkDirector;

  // 3. "도지사" → 도. 결과가 "도"로 끝날 때만 제거해 "(주)크립톤 전북지사"(회사 지사) 오제거를 막는다.
  if (value.endsWith("지사")) {
    const candidate = value.slice(0, -2).trimEnd();
    if (candidate.endsWith("도")) return candidate;
  }

  // 4. "군수" → 군. 결과가 "군"으로 끝날 때만 제거한다.
  if (value.endsWith("군수")) {
    const candidate = value.slice(0, -1); // "수" 한 글자만 제거 → "…군"
    if (candidate.endsWith("군")) return candidate;
  }

  // 5. 단일 "장" 제거 — 결과가 기관형 어미(원·청·시)로 끝날 때만.
  //    "창업진흥원장" → "창업진흥원"(원), "특허청장" → "특허청"(청), "서울특별시장" → "서울특별시"(시).
  //    "창업진흥"으로 뭉개지지 않고(가드 통과), "㈜오퍼스이앤씨 센터장"(→"…센터", 터)은 미제거.
  if (value.endsWith("장")) {
    const candidate = value.slice(0, -1).trimEnd();
    if (/[원청시]$/.test(candidate)) return candidate;
  }

  return value;
}

/**
 * 기관명 원문을 정규화한다. 공백 정리 → 플레이스홀더 null → 법인격 접두 제거 → 직함 접미 제거.
 * 어떤 규칙에도 걸리지 않으면 공백만 정리한 값을 그대로 돌려준다.
 */
export function normalizeAgencyName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let value = collapseWhitespace(raw);
  if (value === "" || isPlaceholder(value)) return null;

  value = stripLegalEntityPrefix(value);
  value = stripTitleSuffix(value);
  value = collapseWhitespace(value);

  if (value === "" || isPlaceholder(value)) return null;
  return value;
}

function isBizInfoNonAgencyOperator(operator: string): boolean {
  return BIZINFO_NON_AGENCY_OPERATORS.has(operator.trim());
}

/**
 * 출처별 규칙으로 "주관기관명" 하나를 뽑아 정규화한다.
 *   - K-Startup 계열: agency_jurisdiction 사용(operator 는 담당 부서명이라 기관명이 아니므로 폴백하지 않는다).
 *   - BizInfo/bizinfo_event: agency_operator(수행기관) 우선, 비기관 값이면 agency_jurisdiction(소관) 폴백.
 */
export function resolveGrantAgencyPrimary(input: {
  source: GrantSource;
  jurisdiction: string | null;
  operator: string | null;
}): string | null {
  const { source, jurisdiction, operator } = input;

  if (source === "bizinfo" || source === "bizinfo_event") {
    if (operator && !isBizInfoNonAgencyOperator(operator)) {
      const normalizedOperator = normalizeAgencyName(operator);
      if (normalizedOperator) return normalizedOperator;
    }
    return normalizeAgencyName(jurisdiction);
  }

  // K-Startup 계열: 주관기관명은 jurisdiction 에 담긴다.
  return normalizeAgencyName(jurisdiction);
}

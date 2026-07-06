/**
 * KSIC(한국표준산업분류) 정적 사전 — 11차 기준 대분류(21개, A~U)·중분류(2자리, 77개)만 수록.
 *
 * 세세분류(5자리)는 유지비용 대비 효과가 낮아 수록하지 않는다. 대신 코드 해석은
 * prefix 축약(5→4→3→2자리)으로 중분류·대분류를 도출한다. 팝빌 industryCode는 국세청
 * 6자리 업종코드가 아니라 KSIC 계열 코드(예: "58222", 패딩성 "58200")로 온다.
 *
 * 중분류 코드 범위(대분류 소속)는 KSIC 10차·11차에서 동일하므로 섹션 귀속은 안정적이다.
 */

export interface KsicSection {
  /** 대분류 코드 (A~U) */
  code: string;
  label: string;
}

export interface KsicDivision {
  /** 중분류 코드 (2자리 숫자) */
  code: string;
  label: string;
  /** 소속 대분류 코드 (A~U) */
  section: string;
}

export const KSIC_SECTIONS: readonly KsicSection[] = [
  { code: "A", label: "농업, 임업 및 어업" },
  { code: "B", label: "광업" },
  { code: "C", label: "제조업" },
  { code: "D", label: "전기, 가스, 증기 및 공기 조절 공급업" },
  { code: "E", label: "수도, 하수 및 폐기물 처리, 원료 재생업" },
  { code: "F", label: "건설업" },
  { code: "G", label: "도매 및 소매업" },
  { code: "H", label: "운수 및 창고업" },
  { code: "I", label: "숙박 및 음식점업" },
  { code: "J", label: "정보통신업" },
  { code: "K", label: "금융 및 보험업" },
  { code: "L", label: "부동산업" },
  { code: "M", label: "전문, 과학 및 기술 서비스업" },
  { code: "N", label: "사업시설 관리, 사업 지원 및 임대 서비스업" },
  { code: "O", label: "공공행정, 국방 및 사회보장 행정" },
  { code: "P", label: "교육 서비스업" },
  { code: "Q", label: "보건업 및 사회복지 서비스업" },
  { code: "R", label: "예술, 스포츠 및 여가관련 서비스업" },
  { code: "S", label: "협회 및 단체, 수리 및 기타 개인 서비스업" },
  { code: "T", label: "가구 내 고용활동 및 달리 분류되지 않은 자가소비 생산활동" },
  { code: "U", label: "국제 및 외국기관" },
];

export const KSIC_DIVISIONS: readonly KsicDivision[] = [
  // A 농업, 임업 및 어업
  { code: "01", label: "농업", section: "A" },
  { code: "02", label: "임업", section: "A" },
  { code: "03", label: "어업", section: "A" },
  // B 광업
  { code: "05", label: "석탄, 원유 및 천연가스 광업", section: "B" },
  { code: "06", label: "금속 광업", section: "B" },
  { code: "07", label: "비금속광물 광업; 연료용 제외", section: "B" },
  { code: "08", label: "광업 지원 서비스업", section: "B" },
  // C 제조업
  { code: "10", label: "식료품 제조업", section: "C" },
  { code: "11", label: "음료 제조업", section: "C" },
  { code: "12", label: "담배 제조업", section: "C" },
  { code: "13", label: "섬유제품 제조업; 의복 제외", section: "C" },
  { code: "14", label: "의복, 의복 액세서리 및 모피제품 제조업", section: "C" },
  { code: "15", label: "가죽, 가방 및 신발 제조업", section: "C" },
  { code: "16", label: "목재 및 나무제품 제조업; 가구 제외", section: "C" },
  { code: "17", label: "펄프, 종이 및 종이제품 제조업", section: "C" },
  { code: "18", label: "인쇄 및 기록매체 복제업", section: "C" },
  { code: "19", label: "코크스, 연탄 및 석유정제품 제조업", section: "C" },
  { code: "20", label: "화학 물질 및 화학제품 제조업; 의약품 제외", section: "C" },
  { code: "21", label: "의료용 물질 및 의약품 제조업", section: "C" },
  { code: "22", label: "고무 및 플라스틱제품 제조업", section: "C" },
  { code: "23", label: "비금속 광물제품 제조업", section: "C" },
  { code: "24", label: "1차 금속 제조업", section: "C" },
  { code: "25", label: "금속 가공제품 제조업; 기계 및 가구 제외", section: "C" },
  { code: "26", label: "전자부품, 컴퓨터, 영상, 음향 및 통신장비 제조업", section: "C" },
  { code: "27", label: "의료, 정밀, 광학 기기 및 시계 제조업", section: "C" },
  { code: "28", label: "전기장비 제조업", section: "C" },
  { code: "29", label: "기타 기계 및 장비 제조업", section: "C" },
  { code: "30", label: "자동차 및 트레일러 제조업", section: "C" },
  { code: "31", label: "기타 운송장비 제조업", section: "C" },
  { code: "32", label: "가구 제조업", section: "C" },
  { code: "33", label: "기타 제품 제조업", section: "C" },
  { code: "34", label: "산업용 기계 및 장비 수리업", section: "C" },
  // D 전기, 가스, 증기 및 공기 조절 공급업
  { code: "35", label: "전기, 가스, 증기 및 공기 조절 공급업", section: "D" },
  // E 수도, 하수 및 폐기물 처리, 원료 재생업
  { code: "36", label: "수도업", section: "E" },
  { code: "37", label: "하수, 폐수 및 분뇨 처리업", section: "E" },
  { code: "38", label: "폐기물 수집, 운반, 처리 및 원료 재생업", section: "E" },
  { code: "39", label: "환경 정화 및 복원업", section: "E" },
  // F 건설업
  { code: "41", label: "종합 건설업", section: "F" },
  { code: "42", label: "전문직별 공사업", section: "F" },
  // G 도매 및 소매업
  { code: "45", label: "자동차 및 부품 판매업", section: "G" },
  { code: "46", label: "도매 및 상품 중개업", section: "G" },
  { code: "47", label: "소매업; 자동차 제외", section: "G" },
  // H 운수 및 창고업
  { code: "49", label: "육상 운송 및 파이프라인 운송업", section: "H" },
  { code: "50", label: "수상 운송업", section: "H" },
  { code: "51", label: "항공 운송업", section: "H" },
  { code: "52", label: "창고 및 운송관련 서비스업", section: "H" },
  // I 숙박 및 음식점업
  { code: "55", label: "숙박업", section: "I" },
  { code: "56", label: "음식점 및 주점업", section: "I" },
  // J 정보통신업
  { code: "58", label: "출판업", section: "J" },
  { code: "59", label: "영상·오디오 기록물 제작 및 배급업", section: "J" },
  { code: "60", label: "방송 및 영상물 제공 서비스업", section: "J" },
  { code: "61", label: "우편 및 통신업", section: "J" },
  { code: "62", label: "컴퓨터 프로그래밍, 시스템 통합 및 관리업", section: "J" },
  { code: "63", label: "정보서비스업", section: "J" },
  // K 금융 및 보험업
  { code: "64", label: "금융업", section: "K" },
  { code: "65", label: "보험 및 연금업", section: "K" },
  { code: "66", label: "금융 및 보험 관련 서비스업", section: "K" },
  // L 부동산업
  { code: "68", label: "부동산업", section: "L" },
  // M 전문, 과학 및 기술 서비스업
  { code: "70", label: "연구개발업", section: "M" },
  { code: "71", label: "전문 서비스업", section: "M" },
  { code: "72", label: "건축 기술, 엔지니어링 및 기타 과학기술 서비스업", section: "M" },
  { code: "73", label: "기타 전문, 과학 및 기술 서비스업", section: "M" },
  // N 사업시설 관리, 사업 지원 및 임대 서비스업
  { code: "74", label: "사업시설 관리 및 조경 서비스업", section: "N" },
  { code: "75", label: "사업 지원 서비스업", section: "N" },
  { code: "76", label: "임대업; 부동산 제외", section: "N" },
  // O 공공행정, 국방 및 사회보장 행정
  { code: "84", label: "공공행정, 국방 및 사회보장 행정", section: "O" },
  // P 교육 서비스업
  { code: "85", label: "교육 서비스업", section: "P" },
  // Q 보건업 및 사회복지 서비스업
  { code: "86", label: "보건업", section: "Q" },
  { code: "87", label: "사회복지 서비스업", section: "Q" },
  // R 예술, 스포츠 및 여가관련 서비스업
  { code: "90", label: "창작, 예술 및 여가관련 서비스업", section: "R" },
  { code: "91", label: "스포츠 및 오락관련 서비스업", section: "R" },
  // S 협회 및 단체, 수리 및 기타 개인 서비스업
  { code: "94", label: "협회 및 단체", section: "S" },
  { code: "95", label: "개인 및 소비용품 수리업", section: "S" },
  { code: "96", label: "기타 개인 서비스업", section: "S" },
  // T 가구 내 고용활동 및 달리 분류되지 않은 자가소비 생산활동
  { code: "97", label: "가구 내 고용활동", section: "T" },
  { code: "98", label: "달리 분류되지 않은 자가소비를 위한 가구의 재화 및 서비스 생산활동", section: "T" },
  // U 국제 및 외국기관
  { code: "99", label: "국제 및 외국기관", section: "U" },
];

const SECTION_BY_CODE = new Map(KSIC_SECTIONS.map((section) => [section.code, section]));
const DIVISION_BY_CODE = new Map(KSIC_DIVISIONS.map((division) => [division.code, division]));

export interface KsicResolution {
  input: string;
  normalized: string;
  division?: KsicDivision;
  section?: KsicSection;
  level: "division" | "section" | "none";
}

function normalizeCode(code: string | null | undefined): string {
  return (code ?? "").toString().trim().toUpperCase();
}

/** 숫자 코드에서 5→4→3→2자리 prefix 축약으로 중분류를 도출한다(사전은 2자리까지 보유). */
function resolveDivisionByDigits(digits: string): KsicDivision | undefined {
  const max = Math.min(digits.length, 5);
  for (let len = max; len >= 2; len -= 1) {
    const division = DIVISION_BY_CODE.get(digits.slice(0, len));
    if (division) return division;
  }
  return undefined;
}

/**
 * KSIC 코드(숫자 "58222"/"58200", 문자접두 "J62"/"C25", 대분류 "C")를 해석해
 * 중분류·대분류를 도출한다.
 */
export function resolveKsic(code: string | null | undefined): KsicResolution {
  const normalized = normalizeCode(code);
  const result: KsicResolution = { input: code ?? "", normalized, level: "none" };
  if (!normalized) return result;

  const letterMatch = /^([A-U])(\d*)$/.exec(normalized);
  if (letterMatch) {
    const sectionLetter = letterMatch[1] as string;
    const digits = letterMatch[2] ?? "";
    if (digits.length >= 2) {
      const division = resolveDivisionByDigits(digits);
      if (division) {
        result.division = division;
        const section = SECTION_BY_CODE.get(division.section);
        if (section) result.section = section;
        result.level = "division";
        return result;
      }
    }
    const section = SECTION_BY_CODE.get(sectionLetter);
    if (section) {
      result.section = section;
      result.level = "section";
    }
    return result;
  }

  if (/^\d{2,}$/.test(normalized)) {
    const division = resolveDivisionByDigits(normalized);
    if (division) {
      result.division = division;
      const section = SECTION_BY_CODE.get(division.section);
      if (section) result.section = section;
      result.level = "division";
    }
  }
  return result;
}

export function ksicDivisionLabel(code: string | null | undefined): string | null {
  return resolveKsic(code).division?.label ?? null;
}

export function ksicSectionLabel(code: string | null | undefined): string | null {
  return resolveKsic(code).section?.label ?? null;
}

/** 문자열이 KSIC 코드로 해석 가능한지(라벨 문자열과 구분하기 위한 판정). */
export function isLikelyKsicCode(value: string | null | undefined): boolean {
  const normalized = normalizeCode(value);
  if (!normalized) return false;
  if (!/^[A-U]?\d*$/.test(normalized)) return false;
  if (normalized.length > 6) return false;
  return resolveKsic(normalized).level !== "none";
}

/** 원 코드에서 [정규화 원코드, 중분류(2자리), 대분류(A~U)] 파생 코드 배열을 만든다(중복 제거). */
export function expandKsicCodes(code: string | null | undefined): string[] {
  const resolution = resolveKsic(code);
  if (resolution.level === "none") return [];
  const codes: string[] = [];
  if (resolution.normalized) codes.push(resolution.normalized);
  if (resolution.division) codes.push(resolution.division.code);
  if (resolution.section) codes.push(resolution.section.code);
  return unique(codes);
}

function numericPart(code: string): string | null {
  const match = /^[A-U]?(\d{2,})$/.exec(normalizeCode(code));
  return match ? (match[1] as string) : null;
}

function sectionLetterOf(code: string): string | null {
  return resolveKsic(code).section?.code ?? null;
}

/**
 * 공고 criterion 코드가 회사 코드를 포괄하는지 prefix 매칭한다.
 * - 숫자 prefix: 공고 "58" ⊃ 회사 "58222" (중분류 번호는 대분류 간 유일하므로 안전)
 * - 대분류 문자: 공고 "C" ⊃ 회사 중분류가 C 소속이면 매칭
 */
export function industryCodeMatches(
  criterionCodes: readonly string[],
  companyCodes: readonly string[],
): boolean {
  const crit = criterionCodes.map(normalizeCode).filter(Boolean);
  const comp = companyCodes.map(normalizeCode).filter(Boolean);
  if (crit.length === 0 || comp.length === 0) return false;

  for (const criterion of crit) {
    const criterionNumeric = numericPart(criterion);
    const criterionSection = criterionNumeric ? null : sectionLetterOf(criterion);
    for (const company of comp) {
      if (criterionNumeric) {
        const companyNumeric = numericPart(company);
        if (companyNumeric && companyNumeric.startsWith(criterionNumeric)) return true;
      } else if (criterionSection) {
        if (sectionLetterOf(company) === criterionSection) return true;
      }
    }
  }
  return false;
}

/**
 * 업종 항목 배열을 라벨과 코드로 분리한다. 라벨 문자열은 '/' 구분자로 개별 라벨로 분해한다.
 * (구형 캐시: 코드와 '/' 결합 라벨이 industries 배열에 섞여 있던 형식을 정규화)
 */
export function splitIndustryEntries(entries: readonly string[]): {
  labels: string[];
  codes: string[];
} {
  const labels: string[] = [];
  const codes: string[] = [];
  for (const entry of entries) {
    const trimmed = (entry ?? "").toString().trim();
    if (!trimmed) continue;
    if (isLikelyKsicCode(trimmed)) {
      codes.push(...expandKsicCodes(trimmed));
      continue;
    }
    for (const part of trimmed.split("/")) {
      const label = part.trim();
      if (label && !isLikelyKsicCode(label)) labels.push(label);
    }
  }
  return { labels: unique(labels), codes: unique(codes) };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

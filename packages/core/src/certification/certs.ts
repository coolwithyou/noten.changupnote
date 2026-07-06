/**
 * 인증(certification) 어휘 사전 — canonical 인증 + 별칭(aliases) 정규식.
 *
 * 목적: 공고측 표기("여성기업")와 기업측 표기("여성기업확인서", SMPP 보강)가 달라도
 * 같은 인증으로 매칭되도록 양쪽을 canonical 로 수렴시킨다.
 *
 * 단일 원천: 이 파일이 인증 canonical/별칭의 유일한 정의처다.
 * - `canonicalizeCert(raw)`  : 자유 텍스트 라벨 하나 → 대표 canonical(첫 매치) 또는 null.
 * - `certsMatch(a, b)`       : 양쪽 배열을 canonical 화한 뒤 교집합 존재 여부.
 * - `extractCerts(raw)`      : 한 문자열에서 등장하는 모든 canonical(중복 제거).
 * - `findCertMatches(raw)`   : 등장 위치까지 반환(정규화 룰의 긍정 템플릿 판정용).
 *
 * 주의: 특허·실용신안·상표·디자인권·품종보호권 등 지식재산(IP)은 이 사전의 대상이 아니다.
 * 그런 문구는 ip 축이므로 여기서 canonical 로 잡지 않고 normalize 에서 placeholder 로 남긴다.
 */

/** 구조화가 인정하는 canonical 인증 집합. */
export const CANONICAL_CERTS = [
  "벤처기업",
  "이노비즈",
  "메인비즈",
  "기업부설연구소",
  "연구개발전담부서",
  "여성기업",
  "장애인기업",
  "사회적기업",
  "예비사회적기업",
  "마을기업",
  "협동조합",
  "ISO9001",
  "ISO14001",
  "HACCP",
  "GMP",
  "뿌리기업",
  "소재부품장비전문기업",
] as const;

export type CanonicalCert = (typeof CANONICAL_CERTS)[number];

interface CertRule {
  canonical: CanonicalCert;
  /** 별칭 탐지 정규식(공백/하이픈 관대, 라틴은 대소문자 무시). 전역 플래그 없이 정의한다. */
  pattern: RegExp;
}

/**
 * 인증 탐지 룰 — 구체적(긴)·중첩 위험이 있는 룰을 앞에 둔다.
 * 추출(extractCerts)은 이 순서대로 스캔하면서 매치 구간을 마스킹해, "예비사회적기업"이
 * "사회적기업"으로 중복 계상되는 것을 막는다.
 */
export const CERT_RULES: readonly CertRule[] = [
  { canonical: "ISO14001", pattern: /ISO\s*14001/i },
  { canonical: "ISO9001", pattern: /ISO\s*9001/i },
  // "예비/(예비)" 사회적기업은 별도 canonical. 사회적기업보다 먼저 잡아 마스킹한다.
  { canonical: "예비사회적기업", pattern: /(?:예비|\(예비\))\s*사회적\s*기업/ },
  { canonical: "사회적기업", pattern: /사회적\s*기업/ },
  { canonical: "소재부품장비전문기업", pattern: /소재[·,\s]*부품[·,\s]*장비\s*전문\s*기업|소부장\s*전문\s*기업|소부장\s*기업/ },
  // 기업부설연구소는 반드시 "부설"을 요구한다(맨 "연구소"는 본사·지사·연구소 같은 시설 언급이라 제외).
  { canonical: "기업부설연구소", pattern: /(?:기업\s*)?부설\s*연구소/ },
  // 연구개발전담부서도 "연구/연구개발" 수식을 요구한다(맨 "전담부서" 오탐 방지).
  { canonical: "연구개발전담부서", pattern: /(?:연구\s*개발|연구)\s*전담\s*부서/ },
  { canonical: "여성기업", pattern: /여성\s*기업(?:\s*확인서)?/ },
  { canonical: "장애인기업", pattern: /장애인\s*기업(?:\s*확인서)?/ },
  // "중소벤처기업부/장관/진흥공단" 등 부처·기관명은 벤처기업 인증이 아니므로 뒤 경계를 배제한다.
  { canonical: "벤처기업", pattern: /벤처\s*기업(?!\s*(?:부|장관|청|진흥|진흥공단))|벤처\s*확인|벤처\s*인증/ },
  { canonical: "이노비즈", pattern: /이노비즈|INNO\s*-?\s*BIZ|기술\s*혁신\s*형/i },
  { canonical: "메인비즈", pattern: /메인비즈|MAIN\s*-?\s*BIZ|경영\s*혁신\s*형/i },
  { canonical: "마을기업", pattern: /마을\s*기업/ },
  { canonical: "협동조합", pattern: /협동\s*조합/ },
  { canonical: "뿌리기업", pattern: /뿌리\s*기업|뿌리\s*기술\s*전문\s*기업/ },
  { canonical: "HACCP", pattern: /HACCP|해썹/i },
  { canonical: "GMP", pattern: /GMP/i },
];

export interface CertMatch {
  canonical: CanonicalCert;
  /** 원문 내 매치 시작 위치. */
  index: number;
  /** 매치된 원문 조각. */
  text: string;
}

/**
 * 문자열에서 인증 canonical 을 등장 위치와 함께 추출한다.
 * 매치 구간을 공백으로 마스킹하며 진행해, 상위(구체) 룰이 잡은 구간을 하위 룰이 재계상하지 않는다.
 */
export function findCertMatches(raw: string): CertMatch[] {
  const text = raw ?? "";
  if (!text) return [];
  let masked = text;
  const matches: CertMatch[] = [];
  for (const rule of CERT_RULES) {
    const hit = rule.pattern.exec(masked);
    if (!hit || hit.index === undefined) continue;
    matches.push({ canonical: rule.canonical, index: hit.index, text: hit[0] });
    // 매치 구간을 같은 길이의 공백으로 치환(인덱스 보존).
    masked =
      masked.slice(0, hit.index) + " ".repeat(hit[0].length) + masked.slice(hit.index + hit[0].length);
  }
  return matches.sort((a, b) => a.index - b.index);
}

/** 문자열에 등장하는 canonical 인증 전체(중복 제거, 등장 순서). */
export function extractCerts(raw: string): CanonicalCert[] {
  const seen = new Set<CanonicalCert>();
  const out: CanonicalCert[] = [];
  for (const match of findCertMatches(raw)) {
    if (seen.has(match.canonical)) continue;
    seen.add(match.canonical);
    out.push(match.canonical);
  }
  return out;
}

/** 라벨 하나를 대표 canonical 로 정규화. 미등재면 null. */
export function canonicalizeCert(raw: string): CanonicalCert | null {
  return extractCerts(raw)[0] ?? null;
}

/**
 * 기업 보유 인증과 공고 요구 인증을 canonical 교집합으로 비교한다.
 * 양쪽 모두 자유 텍스트를 허용하며(예: "여성기업확인서" vs "여성기업", "벤처기업, 이노비즈"),
 * 각 원소를 extractCerts 로 canonical 집합으로 펼친 뒤 겹치면 true.
 */
export function certsMatch(companyCerts: readonly string[], requiredCerts: readonly string[]): boolean {
  const required = new Set<CanonicalCert>();
  for (const cert of requiredCerts) for (const c of extractCerts(cert)) required.add(c);
  if (required.size === 0) return false;
  for (const cert of companyCerts) {
    for (const c of extractCerts(cert)) {
      if (required.has(c)) return true;
    }
  }
  return false;
}

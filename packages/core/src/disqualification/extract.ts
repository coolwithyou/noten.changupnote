/**
 * 문장 단위 rule-based 결격(배제) 분해기 — 공고매칭 차원 확장 P4.
 *
 * 단일 원천: kstartup(aply_excl_trgt_ctnt)·bizinfo 폴백이 공용으로 소비하는 deterministic 분해기.
 * 배제 문장을 문장 단위로 쪼갠 뒤, DB 백업 27종 문구를 시드로 한 regex 패턴 사전으로
 * 각 문장을 구조화 criteria(신설 12축 + industry not_in + business_status not_in)에 귀속시킨다.
 *
 * 설계 계약(plan §1 D6·D7, §3 P4, §6):
 *  - **C2**: 중복수혜·참여 중 과제·프로그램 수료류(27종 표 #8/#10/#13/#20)는 구조화 금지.
 *    prior_award 축을 절대 생성하지 않고 해당 문장은 text_only 잔존(소비하지 않음)으로 둔다.
 *  - **M1(span 정책)**: 각 criterion의 source_span 은 귀속 문장만. raw_text 전체 원문 복제 금지.
 *  - 예외 조항("납부기한 연장/징수유예 승인 시 예외", "변제계획 정상 이행 예외", "시효 소멸자 제외")은
 *    exceptions canonical(EXCEPTION_FLAG_COVERAGE 키)로 파싱한다.
 *  - 부채비율 임계는 inclusive/exclusive 를 값에 내장해 파싱한다(Minor-2).
 *  - 배제업종은 canonical KSIC 세트(EXCLUDED_INDUSTRIES)에 매핑한다.
 *
 * 출력 계약: 각 criterion 은 P2 evaluator 가 소비하는 값 스키마와 정확히 호환되어야 한다
 * (DisqualificationCriterionValue / FinancialHealthCriterionValue /
 *  InsuredWorkforceCriterionValue / InvestmentCriterionValue + industry/business_status not_in).
 * consumed span(구조화에 소비된 문장)은 normalizer/폴백이 other placeholder 에서 제외하는 데 쓴다.
 */
import type {
  CriterionDimension,
  CriterionKind,
  CriterionOperator,
  GrantCriterion,
} from "@cunote/contracts";
import {
  ALL_DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_EXCEPTIONS,
  EXCEPTION_FLAG_COVERAGE,
  EXCLUDED_INDUSTRIES,
  EXCLUDED_INDUSTRY_KSIC_CODES,
  FLAG_AXIS,
  type DisqualificationAxis,
  type DisqualificationException,
  type DisqualificationFlag,
} from "./canonical.js";

/** 분해기 결과. */
export interface DisqualificationExtractionResult {
  /** 구조화된 criteria(id·grant_id·parser_version 는 호출측이 부여). */
  criteria: Array<Omit<GrantCriterion, "id" | "grant_id" | "parser_version">>;
  /** 구조화에 소비된 문장(other placeholder 에서 제외). */
  consumedSpans: string[];
  /** 구조화하지 않고 text_only 잔존으로 남길 문장(C2 중복수혜류 + 절차·재량). */
  residualSpans: string[];
}

// ── 문장 분할 ───────────────────────────────────────────────────────────────

/**
 * 배제 문구를 문장 단위로 분할한다. 공고문은 불릿(·, ㅇ, -, ∙, ①~④, 1. 2. 등)으로
 * 나열되므로 이들을 문장 경계로 취급한다. 줄바꿈/마침표/불릿을 경계로 쓴다.
 */
export function splitDisqualificationSentences(text: string): string[] {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  // 불릿·번호 마커 앞에 경계 삽입.
  // 주의: 가운뎃점(·/∙)은 불릿(" · ")과 어절 접속사("국세·지방세", "휴·폐업", "파산·회생") 두 용도로
  // 쓰인다. 접속사는 공백 없이 붙으므로, 앞뒤 중 최소 한쪽에 공백/문두가 있는 경우에만 경계로 본다.
  const withBreaks = normalized
    // 문두 또는 공백이 앞선 가운뎃점(불릿)만 경계로. 뒤 공백은 소비하지 않아 접속사 오분할을 막는다.
    .replace(/(^|\s)[·∙]\s*/g, "\n")
    // ※는 직전 조건의 예외 설명인 경우가 많아 경계로 자르지 않는다.
    .replace(/\s*[ㅇ○◦▪▶▷►□■◇◆☞]\s*/g, "\n")
    .replace(/\s*[-–]\s+/g, "\n")
    .replace(/\s*(?:①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|⑪|⑫|⑬|⑭|⑮|⑯|⑰|⑱|⑲|⑳)\s*/g, "\n")
    .replace(/(?:^|\s)(\d{1,2})\.\s+/g, "\n")
    .replace(/(?:^|\s)(?:가|나|다|라|마|바|사|아|자|차|카|타|파|하)\.\s*/g, "\n")
    // K-Startup API에서 괄호 표제로 이어 붙은 대표 배제 항목을 독립 span으로 복원한다.
    .replace(/\s*\((?:중복\s*참여|서류\s*허위\s*제출)\)\s*/g, "\n")
    // ASCII 마침표·물음표·느낌표도 실제 문장 끝(공백/문말)에서만 분리한다. 1000.5 같은 소수점은 보존.
    .replace(/[.!?。](?=\s|$)/g, "\n")
    .replace(/\n+/g, "\n");
  return withBreaks
    .split("\n")
    .map((part) => part.trim())
    // 머리말성 짧은 라벨("신청제외대상", "[평가 제외 대상]" 등)은 문장으로 취급하지 않음.
    .filter((part) => part.length >= 4);
}

// ── 예외 조항 파싱(문장 내부) ───────────────────────────────────────────────

/**
 * 문장 내부의 예외 조항을 canonical 예외로 파싱한다.
 * 예: "납부기한 연장/징수유예 신청하여 결정을 받은 경우" → payment_deferral_approved
 *     "변제계획에 따른 변제를 정상적으로 이행" → repayment_plan_in_good_standing
 *     "시효 소멸자는 제외" → statute_expired
 */
const EXCEPTION_PATTERNS: Array<{ exception: DisqualificationException; pattern: RegExp }> = [
  {
    exception: "payment_deferral_approved",
    pattern: /납부기한\s*연장|징수유예|납부\s*유예|체납액?\s*분납|분할\s*납부\s*(?:승인|결정)/,
  },
  {
    exception: "repayment_plan_in_good_standing",
    pattern:
      /변제계획.{0,20}(?:정상|성실)?\s*(?:이행|변제)|회생계획.{0,20}(?:정상|성실)?\s*(?:이행|변제)|정상적으로\s*이행/,
  },
  { exception: "statute_expired", pattern: /시효\s*(?:소멸|완성|만료)/ },
];

function parseExceptions(sentence: string): DisqualificationException[] {
  const found = new Set<DisqualificationException>();
  for (const { exception, pattern } of EXCEPTION_PATTERNS) {
    if (pattern.test(sentence)) found.add(exception);
  }
  return DISQUALIFICATION_EXCEPTIONS.filter((exception) => found.has(exception));
}

// ── C2: 구조화 금지(중복수혜·참여 중 과제·프로그램 수료류) ────────────────────

/**
 * 27종 표 #8/#10/#13/#20 계열 — prior_award 로 구조화하면 안 되는 문장.
 * 이 패턴에 걸리면 다른 결격 패턴 매칭 여부와 무관하게 그 "부분"은 구조화 대상에서 빠지지만,
 * 분해는 문장 단위이므로 문장 전체를 residual(text_only 잔존)로 돌린다.
 * (동일 문장에 체납+중복수혜가 섞이는 사례는 백업에 없음 — 공고문이 조건별로 문장을 나눔.)
 */
const PRIOR_AWARD_PATTERN =
  /중복\s*(?:입주|지원|수혜|선정|참여)|중복입주|기존.{0,6}선정기업|최종\s*선정기업|동일\s*사업.{0,20}(?:참여|선정|지원|수혜)|동일한?\s*과제|타\s*부처.{0,10}중복|지방자치단체.{0,10}중복\s*지원|수료(?:하였|한|·)|참여\s*중\s*(?:또는\s*)?(?:참여\s*)?예정|사관학교|Start-?up\s*NEST|NEST/i;

// ── 절차·재량 잔존(본질상 other) ──────────────────────────────────────────────

/**
 * 절차·재량 조건(서류 허위·미제출·표절·"기타 부적합"·공해·횡령 등) — 판정 불가, other 잔존이 정답.
 * 이 패턴만 걸리고 다른 결격 패턴이 없으면 residual 로 둔다.
 */
const PROCEDURAL_RESIDUAL_PATTERN =
  /허위|거짓|서류.{0,6}(?:미제출|미비|누락)|제출.{0,6}(?:완료하지|양식.{0,6}준수)|모방|표절|도용|기타.{0,10}(?:부적합|적정하지|판단|인정|사유)|폐수|소음|진동|공해|횡령|사회적\s*물의|자격이\s*맞지|적합하지\s*않/;

// ── 결격 플래그 패턴 사전(백업 27종 시드) ─────────────────────────────────────

interface FlagRule {
  flag: DisqualificationFlag;
  pattern: RegExp;
}

/**
 * 각 문장에서 canonical 결격 플래그를 검출하는 패턴. 하나의 문장이 여러 플래그를 담을 수 있다
 * (예: "채무불이행 등 금융 규제" → loan_default; "연체, 부도, 금융질서문란, 법정관리, 기업회생신청,
 * 청산절차" 처럼 한 문장에 신용 계열 다수).
 */
const FLAG_RULES: FlagRule[] = [
  // tax_compliance — 백업 #1,#3,#4,#5,#6 (국세·지방세 체납이 전 공고 공통)
  { flag: "national_tax_delinquent", pattern: /국세.{0,8}체납|세금.{0,6}체납|국세\s*또는\s*지방세|국세·지방세/ },
  { flag: "local_tax_delinquent", pattern: /지방세.{0,8}체납|국세\s*또는\s*지방세|국세·지방세|지방세를?\s*체납/ },
  { flag: "customs_delinquent", pattern: /관세.{0,8}체납/ },
  { flag: "social_insurance_delinquent", pattern: /4대\s*보험료?.{0,8}체납|사회보험료?.{0,8}체납|국민연금.{0,8}체납|건강보험료?.{0,8}체납/ },
  // credit_status — 백업 #1(#채무불이행),#3,#5,#6,#7
  { flag: "credit_delinquency", pattern: /신용.{0,4}(?:연체|불량)|불량\s*거래자|연체\s*(?:정보|등록)?|기업\s*신용정보상\s*연체/ },
  { flag: "loan_default", pattern: /채무\s*불이행|채무불이행/ },
  { flag: "bond_default", pattern: /부도/ },
  { flag: "rehabilitation_in_progress", pattern: /회생(?:절차)?|개인회생|기업회생/ },
  { flag: "bankruptcy_filed", pattern: /파산/ },
  { flag: "court_receivership", pattern: /법정관리|청산(?:절차)?/ },
  { flag: "financial_misconduct", pattern: /금융질서\s*문란|금융질서문란/ },
  { flag: "asset_seizure", pattern: /압류/ },
  { flag: "guarantee_restricted", pattern: /보증\s*금지|보증\s*제한|보증사고|모집제한/ },
  // sanction — 백업 #1,#3,#5,#6,#7
  { flag: "participation_restricted", pattern: /참여\s*제한|참가\s*제한|참여제한/ },
  { flag: "subsidy_fraud", pattern: /부정\s*수급|부정수급|환수/ },
  { flag: "subsidy_law_violation", pattern: /보조금법\s*위반|보조금\s*법률?\s*위반|특수관계\s*기업/ },
  { flag: "obligation_breach", pattern: /의무\s*불이행|의무를?\s*이행하지/ },
  { flag: "wage_arrears_listed", pattern: /임금\s*체불|체불\s*(?:사업주|명단)/ },
  { flag: "serious_accident_listed", pattern: /중대\s*재해|중대재해\s*(?:명단|처벌)/ },
  { flag: "agreement_breach", pattern: /협약\s*(?:또는\s*)?(?:및\s*)?계약\s*위반|협약\s*위반|계약\s*위반/ },
];

/**
 * "금융기관으로부터 제재 중" 처럼 sanction 어휘가 참여제한이 아니라 금융 제재를 뜻하는 경우
 * credit_status(신용불량 금융 제재) 로 귀속시키는 보조 규칙.
 * "정부/정부지원사업/참여" 문맥이 없고 "금융기관/신용불량/금융" 문맥이면 credit 계열로 본다.
 */
const FINANCIAL_SANCTION_PATTERN = /(?:신용불량|금융기관).{0,20}제재|제재.{0,10}(?:금융기관|신용불량)/;

// ── financial_health(자본잠식·부채비율·이자보상배율) ─────────────────────────

const FULL_IMPAIRMENT_PATTERN = /완전\s*자본잠식/;
const PARTIAL_IMPAIRMENT_PATTERN = /부분\s*자본잠식/;
// "자본잠식"만 단독 언급되면 부분·완전 모두 배제로 본다(공고 표준: 자본잠식 기업 제외).
const ANY_IMPAIRMENT_PATTERN = /자본\s*잠식|자본잠식/;

/** 부채비율 임계 파싱: "부채비율 1,000% 이상 제외" → {value:1000, inclusive:true}. */
function parseDebtRatioThreshold(sentence: string): { value: number; inclusive: boolean } | null {
  const match =
    /부채\s*비율\s*(?:이|가)?\s*([\d,]+(?:\.\d+)?)\s*%?\s*(이상|초과|넘는|넘으면|을?\s*초과)/.exec(sentence);
  if (!match) return null;
  const value = Number((match[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  // "이상" → inclusive, "초과/넘는" → exclusive.
  const inclusive = /이상/.test(match[2] ?? "");
  return { value, inclusive };
}

/** 이자보상배율 임계 파싱: "이자보상배율 1배 미만 제외" → 1. */
function parseInterestCoverage(sentence: string): number | null {
  const match = /이자\s*보상\s*배율\s*(?:이|가)?\s*([\d.]+)\s*배?\s*(?:미만|이하|안되는|밑도는)/.exec(sentence);
  if (!match) return null;
  const value = Number(match[1] ?? "");
  return Number.isFinite(value) ? value : null;
}

// ── insured_workforce(고용보험·피보험자·감원) ────────────────────────────────

const EMPLOYMENT_INSURANCE_PATTERN = /고용\s*보험\s*(?:성립|가입|피보험)|고용보험\s*(?:성립|가입)/;

function parseInsuredCountThreshold(sentence: string): { min: number | null; max: number | null } | null {
  const minMatch = /피보험자?\s*(?:수)?\s*([\d,]+)\s*명?\s*이상/.exec(sentence);
  const maxMatch = /피보험자?\s*(?:수)?\s*([\d,]+)\s*명?\s*이하/.exec(sentence);
  if (!minMatch && !maxMatch) return null;
  return {
    min: minMatch ? Number((minMatch[1] ?? "").replace(/,/g, "")) : null,
    max: maxMatch ? Number((maxMatch[1] ?? "").replace(/,/g, "")) : null,
  };
}

function parseNoLayoffMonths(sentence: string): number | null {
  const match = /(?:최근\s*)?(\d{1,2})\s*개월.{0,10}(?:인위적?\s*)?감원|감원.{0,10}(\d{1,2})\s*개월/.exec(sentence);
  if (!match) return null;
  const months = Number(match[1] ?? match[2]);
  return Number.isFinite(months) ? months : null;
}

// ── investment(투자유치) ──────────────────────────────────────────────────────

function parseInvestmentTotal(sentence: string): number | null {
  // "누적 투자 X억 이상" — 억/원 단위 파싱.
  const eok = /(?:누적\s*)?투자.{0,10}?([\d,.]+)\s*억\s*(?:원)?\s*이상/.exec(sentence);
  if (eok) {
    const value = Number((eok[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(value)) return Math.round(value * 100_000_000);
  }
  return null;
}

const TIPS_OPERATOR_PATTERN = /TIPS\s*운영사|팁스\s*운영사/i;

// ── 배제업종(industry not_in) ────────────────────────────────────────────────

function matchExcludedIndustries(sentence: string): {
  codes: string[];
  labels: string[];
} | null {
  const patterns: Array<{ keys: string[]; pattern: RegExp }> = [
    { keys: ["general_bar", "dancing_bar", "other_bar"], pattern: /유흥주점|무도유흥|주점업/ },
    { keys: ["gambling_facility"], pattern: /사행시설|사행\s*산업|도박/ },
    { keys: ["crypto_asset_brokerage"], pattern: /암호화\s*자산|가상\s*자산|블록체인.{0,10}매매|코인.{0,6}중개/ },
    { keys: ["real_estate"], pattern: /부동산(?:업|\s*관련)/ },
    // "사치·향락" 은 도박/사행과 함께 사행시설 계열로 흡수(전용 KSIC 없음 → 라벨만).
    { keys: [], pattern: /사치|향락/ },
  ];
  const matchedKeys = new Set<string>();
  const genericLuxury = /사치|향락/.test(sentence) && !/유흥|사행|도박|부동산|암호화|가상\s*자산/.test(sentence);
  for (const { keys, pattern } of patterns) {
    if (pattern.test(sentence)) {
      for (const key of keys) matchedKeys.add(key);
    }
  }
  // "지원제외 대상 업종"·"지원제외 업종" 같이 캐논 세트 없이 업종 배제를 언급하는 경우도 있으나,
  // 코드가 없으면 not_in 을 만들 수 없다(오탐 위험) → 전체 배제업종 세트로 귀속하지 않고 residual.
  if (matchedKeys.size === 0 && !genericLuxury) return null;

  const industries = EXCLUDED_INDUSTRIES.filter((industry) => matchedKeys.has(industry.key));
  const codes = industries.length > 0
    ? [...new Set(industries.flatMap((industry) => industry.ksic))]
    : [];
  const labels = industries.map((industry) => industry.label);
  if (genericLuxury) labels.push("사치·향락");
  return { codes, labels };
}

// ── business_status(휴·폐업) ──────────────────────────────────────────────────

const BUSINESS_CLOSED_PATTERN = /휴\s*[·.]?\s*폐업|휴업|폐업/;

// ── 메인 분해기 ───────────────────────────────────────────────────────────────

interface StructuredEmission {
  dimension: CriterionDimension;
  operator: CriterionOperator;
  kind: CriterionKind;
  value: Record<string, unknown>;
  suffix: string;
}

/**
 * 배제 문구(text)를 문장 단위로 분해해 구조화 criteria + consumed/residual span 을 만든다.
 *
 * @param sourceField criterion.source_field 로 기록할 원 필드명(예: aply_excl_trgt_ctnt).
 * @param confidence 룰 기반 검수 전 신뢰도(기본 0.6, needs_review=true 유지).
 */
export function extractDisqualificationCriteria(
  text: string,
  options: { sourceField?: string; confidence?: number } = {},
): DisqualificationExtractionResult {
  const sourceField = options.sourceField ?? "aply_excl_trgt_ctnt";
  const confidence = options.confidence ?? 0.6;
  const sentences = splitDisqualificationSentences(text);

  const criteria: DisqualificationExtractionResult["criteria"] = [];
  const consumedSpans: string[] = [];
  const residualSpans: string[] = [];

  // 예외 절 귀속(§P4): "- 납부기한 연장 … 신청 가능", "※ … 예외" 같은 하위 예외 절은 별도 문장으로
  // 쪼개지지만 직전 조건 문장에 귀속된다. 자체적으로 결격 플래그가 없고 예외 마커만 있는 문장을
  // 예외-전용 문장으로 보고, 직전 "구조화 조건 문장"의 예외 집합에 병합한다. 예외-전용 문장은 소비 처리.
  const exceptionOnlySentences = new Set<number>();
  const attachedExceptions = new Map<number, Set<DisqualificationException>>();
  let lastConditionIndex = -1;
  sentences.forEach((sentence, index) => {
    const flagsHere = FLAG_RULES.some((rule) => rule.pattern.test(sentence));
    const structuredHere =
      flagsHere ||
      BUSINESS_CLOSED_PATTERN.test(sentence) ||
      ANY_IMPAIRMENT_PATTERN.test(sentence) ||
      matchExcludedIndustries(sentence) !== null;
    const exceptionsHere = parseExceptions(sentence);
    const isExceptionMarker = /예외|신청\s*가능|지원\s*가능|제외(?:합니다)?|경우는?\s*(?:신청|지원)?\s*가능/.test(
      sentence,
    );
    if (!structuredHere && exceptionsHere.length > 0 && isExceptionMarker && lastConditionIndex >= 0) {
      // 예외-전용 절 → 직전 조건 문장에 귀속.
      exceptionOnlySentences.add(index);
      const set = attachedExceptions.get(lastConditionIndex) ?? new Set<DisqualificationException>();
      for (const exception of exceptionsHere) set.add(exception);
      attachedExceptions.set(lastConditionIndex, set);
    } else if (structuredHere) {
      lastConditionIndex = index;
    }
  });

  // 문장 순회. 축별 플래그를 문장 단위로 모아 축 하나당 criterion 하나로 병합하지 않고
  // (문장이 곧 판정 근거 span 이므로) 문장별로 축 criterion 을 emit 한다. 예외는 같은 문장 + 귀속 예외 절.
  sentences.forEach((sentence, index) => {
    // 예외-전용 문장은 직전 조건에 이미 병합됨 → 소비 처리하고 스킵.
    if (exceptionOnlySentences.has(index)) {
      consumedSpans.push(sentence);
      return;
    }
    // 1) C2 — 중복수혜류는 구조화 금지(문장 전체 residual). 단, 같은 문장에 명확한 결격 어휘가 없을 때만.
    const isPriorAward = PRIOR_AWARD_PATTERN.test(sentence);

    // 2) 문장에서 검출되는 플래그 수집.
    let hitFlags = FLAG_RULES.filter((rule) => rule.pattern.test(sentence)).map((rule) => rule.flag);

    // 2a) 금융 제재 문맥(신용불량 금융기관 제재)은 sanction(participation_restricted)이 아니라
    //     credit_status 로 재귀속. "정부/지자체/공공기관/정부지원사업" 문맥이면 그대로 sanction.
    const isFinancialSanction =
      FINANCIAL_SANCTION_PATTERN.test(sentence) &&
      !/정부|지자체|공공기관|정부지원|중앙정부|참여제한/.test(sentence);
    if (isFinancialSanction) {
      hitFlags = hitFlags.filter((flag) => flag !== "participation_restricted");
      if (!hitFlags.includes("credit_delinquency")) hitFlags.push("credit_delinquency");
    }

    const attached = attachedExceptions.get(index);
    const exceptions = DISQUALIFICATION_EXCEPTIONS.filter(
      (exception) => parseExceptions(sentence).includes(exception) || attached?.has(exception),
    );

    // 3) 배제업종·휴폐업·재무·고용·투자 구조화 대상 검출.
    const industry = matchExcludedIndustries(sentence);
    const businessClosed = BUSINESS_CLOSED_PATTERN.test(sentence);
    const debtThreshold = parseDebtRatioThreshold(sentence);
    const interestCoverage = parseInterestCoverage(sentence);
    const fullImpairment = FULL_IMPAIRMENT_PATTERN.test(sentence);
    const partialImpairment = PARTIAL_IMPAIRMENT_PATTERN.test(sentence);
    const anyImpairment = !fullImpairment && !partialImpairment && ANY_IMPAIRMENT_PATTERN.test(sentence);
    const insuranceRequired = EMPLOYMENT_INSURANCE_PATTERN.test(sentence);
    const insuredThreshold = parseInsuredCountThreshold(sentence);
    const noLayoffMonths = parseNoLayoffMonths(sentence);
    const investmentTotal = parseInvestmentTotal(sentence);
    const tipsRequired = TIPS_OPERATOR_PATTERN.test(sentence);

    const emissions: StructuredEmission[] = [];

    // 3a) 결격 3축 — 축별로 문장의 플래그를 묶어 emit.
    if (hitFlags.length > 0) {
      const byAxis = new Map<DisqualificationAxis, DisqualificationFlag[]>();
      for (const flag of hitFlags) {
        const axis = FLAG_AXIS[flag];
        const list = byAxis.get(axis) ?? [];
        if (!list.includes(flag)) list.push(flag);
        byAxis.set(axis, list);
      }
      for (const [axis, flags] of byAxis) {
        // 예외는 그 축 플래그를 실제로 커버하는 것만 붙인다(오적용 방지).
        const axisExceptions = exceptions.filter((exception) =>
          flags.some((flag) => FLAG_AXIS[flag] === axis && exceptionCoversFlag(exception, flag)),
        );
        const value: Record<string, unknown> = { flags };
        if (axisExceptions.length > 0) value.exceptions = axisExceptions;
        emissions.push({
          dimension: axis,
          operator: "in",
          kind: "exclusion",
          value,
          suffix: axis,
        });
      }
    }

    // 3b) 배제업종(코드가 있으면 not_in industry, 없으면 라벨만 있는 경우 residual 처리를 위해 스킵).
    if (industry && industry.codes.length > 0) {
      emissions.push({
        dimension: "industry",
        operator: "not_in",
        kind: "exclusion",
        value: {
          codes: industry.codes,
          labels: industry.labels,
          industries: industry.labels,
        },
        suffix: "industry-excluded",
      });
    }

    // 3c) 휴·폐업.
    if (businessClosed) {
      emissions.push({
        dimension: "business_status",
        operator: "not_in",
        kind: "exclusion",
        value: { statuses: ["closed"], labels: ["휴폐업"] },
        suffix: "business-status",
      });
    }

    // 3d) financial_health.
    if (debtThreshold || interestCoverage !== null || fullImpairment || partialImpairment || anyImpairment) {
      const value: Record<string, unknown> = {};
      if (debtThreshold) value.debt_ratio_pct_threshold = debtThreshold;
      const impairmentExcluded: Array<"partial" | "full"> = [];
      if (fullImpairment) impairmentExcluded.push("full");
      if (partialImpairment) impairmentExcluded.push("partial");
      if (anyImpairment) impairmentExcluded.push("partial", "full");
      if (impairmentExcluded.length > 0) value.impairment_excluded = impairmentExcluded;
      if (interestCoverage !== null) value.min_interest_coverage = interestCoverage;
      emissions.push({
        dimension: "financial_health",
        operator: "lte",
        kind: "exclusion",
        value,
        suffix: "financial-health",
      });
    }

    // 3e) insured_workforce.
    if (insuranceRequired || insuredThreshold || noLayoffMonths !== null) {
      const value: Record<string, unknown> = {};
      if (insuranceRequired) value.employment_insurance_required = true;
      if (insuredThreshold?.min !== null && insuredThreshold?.min !== undefined) value.min_insured = insuredThreshold.min;
      if (insuredThreshold?.max !== null && insuredThreshold?.max !== undefined) value.max_insured = insuredThreshold.max;
      if (noLayoffMonths !== null) value.no_layoff_within_months = noLayoffMonths;
      emissions.push({
        dimension: "insured_workforce",
        operator: "gte",
        // 고용보험 성립·피보험자 하한은 required, 감원 배제는 exclusion 성격이나 evaluator 는 kind 로
        // 극성 반전을 하지 않으므로(필드별 fail 판정) required 로 통일한다.
        kind: "required",
        value,
        suffix: "insured-workforce",
      });
    }

    // 3f) investment.
    if (investmentTotal !== null || tipsRequired) {
      const value: Record<string, unknown> = {};
      if (investmentTotal !== null) value.min_total_krw = investmentTotal;
      if (tipsRequired) value.tips_operator_required = true;
      emissions.push({
        dimension: "investment",
        operator: "gte",
        kind: "required",
        value,
        suffix: "investment",
      });
    }

    // 4) 귀속 판정.
    if (emissions.length > 0 && !isPriorAward) {
      consumedSpans.push(sentence);
      for (const emission of emissions) {
        criteria.push({
          dimension: emission.dimension,
          operator: emission.operator,
          kind: emission.kind,
          value: emission.value,
          confidence,
          source_field: sourceField,
          source_span: sentence, // M1: 귀속 문장만.
          needs_review: true,
        });
      }
      return;
    }

    // 5) 구조화 못 한 문장 — C2/절차/재량/코드 없는 업종배제 → residual(text_only 잔존).
    residualSpans.push(sentence);
  });

  return { criteria, consumedSpans, residualSpans };
}

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

const EXCEPTION_COVERAGE_INDEX = new Map<DisqualificationException, Set<DisqualificationFlag>>();
for (const exception of DISQUALIFICATION_EXCEPTIONS) {
  EXCEPTION_COVERAGE_INDEX.set(exception, new Set(EXCEPTION_FLAG_COVERAGE[exception]));
}

function exceptionCoversFlag(
  exception: DisqualificationException,
  flag: DisqualificationFlag,
): boolean {
  return EXCEPTION_COVERAGE_INDEX.get(exception)?.has(flag) ?? false;
}

/** 배제업종 전체 KSIC(모든 배제업종을 통째로 not_in 하고 싶을 때의 편의 — 현재 미사용, 재사용 대비). */
export const ALL_EXCLUDED_INDUSTRY_CODES = EXCLUDED_INDUSTRY_KSIC_CODES;
export const ALL_FLAGS_FOR_TEST = ALL_DISQUALIFICATION_FLAGS;

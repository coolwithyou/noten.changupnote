/**
 * 근로복지공단(kcomwel) 고용·산재보험 가입 사업장 현황 — 공공데이터포털 OpenAPI(15059256).
 *
 * 사업자번호로 고용/산재보험 가입 사업장의 상시인원·성립일을 조회한다. 팝빌·국세청·apick 어디에도
 * 없는 "상시근로자수(근사)"와 "고용보험 성립여부"를 무료로 보강하기 위한 소스다.
 * 호출부(dev 하네스)에서 fail-open으로 다뤄야 하므로 전송/HTTP/파싱 실패 시 throw 한다.
 *
 * 엔드포인트(실측 2026-07-11, data.go.kr 원문):
 *   GET http://apis.data.go.kr/B490001/gySjbPstateInfoService/getGySjBoheomBsshItem
 *     ?serviceKey={key}&v_saeopjaDrno=<사업자번호 10자리>&opaBoheomFg=<1산재|2고용>&numOfRows=&pageNo=
 *
 * 응답은 표준 data.go.kr XML(header.resultCode + body.items.item[])이라 의존성 없이
 * 관대한 태그 추출(정규식)로 파싱한다. 출력 항목(원문):
 *   sangsiInwonCnt(상시인원) · saeopjangNm(사업장명) · addr(주소) · seongripDt(성립일자)
 *   · gyEopjongNm(고용업종명) · saeopFg(보험가입구분) · post(우편번호)
 *
 * NOTE(실측): 2026-07-11 기준 이 데이터셋 게이트웨이가 HTTP 502("Error forwarding request to
 * backend server")를 반복 반환한다(백엔드 점검 추정). 502는 KcomwelError로 throw 되어 하네스에서
 * failed 로 렌더된다 — 파서/정규화는 아래 문서화된 스키마로 검증한다.
 */

const KCOMWEL_ENDPOINT =
  "http://apis.data.go.kr/B490001/gySjbPstateInfoService/getGySjBoheomBsshItem";
const DEFAULT_TIMEOUT_MS = 6_000;

/** 보험 구분: 고용(opaBoheomFg=2) | 산재(opaBoheomFg=1). */
export type KcomwelInsuranceKind = "employment" | "accident";

/** getGySjBoheomBsshItem item 1건(가입 사업장 1개). */
export interface KcomwelSite {
  /** 사업장명. */
  saeopjangNm: string | null;
  /** 상시인원(정수). 파싱 불가 시 null. */
  sangsiInwonCnt: number | null;
  /** 주소. */
  addr: string | null;
  /** 성립일자 YYYYMMDD. */
  seongripDt: string | null;
  /** 고용업종명. */
  gyEopjongNm: string | null;
}

/** 사업자번호 1건에 대한 가입 사업장 요약(정규화). */
export interface KcomwelEmploymentSummary {
  /** 조회한 보험 구분. */
  kind: KcomwelInsuranceKind;
  /** 가입 사업장 수. */
  siteCount: number;
  /** 상시인원 합계(사업장 합산). 전부 미파싱이면 null. */
  totalWorkers: number | null;
  /** 최초 성립일자 YYYYMMDD(가장 이른 값). */
  earliestSeongripDt: string | null;
  /** 대표 사업장명(첫 사업장). */
  primarySiteName: string | null;
  /** 보험 성립(가입) 여부 = 사업장이 1개 이상 존재. */
  insuranceActive: boolean;
}

export interface CheckKcomwelEmploymentInput {
  /** 공공데이터포털 인증키. 이미 percent-encoding 되어 있을 수 있다. */
  serviceKey: string;
  /** 조회 대상 사업자번호(하이픈/공백 허용, 내부에서 숫자만 추출). */
  bizNo: string;
  /** 보험 구분. 기본 employment(고용). */
  kind?: KcomwelInsuranceKind;
  /** 목록 건수. 기본 20. */
  numOfRows?: number;
  /** 요청 타임아웃(ms). 기본 4000ms. */
  timeoutMs?: number;
  /** 테스트용 fetch 주입(기본 global fetch). */
  fetchImpl?: typeof fetch;
}

export class KcomwelError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "KcomwelError";
  }
}

const OPA_BOHEOM_FG: Record<KcomwelInsuranceKind, string> = {
  accident: "1",
  employment: "2",
};

/**
 * 고용/산재 가입 사업장을 1회 조회하고 요약을 반환한다.
 * - 사업장이 하나도 없으면(정상 음성 응답) null.
 * - HTTP 오류/네트워크/파싱 실패 시 KcomwelError throw(호출부가 catch 후 fail-open).
 */
export async function checkKcomwelEmployment(
  input: CheckKcomwelEmploymentInput,
): Promise<KcomwelEmploymentSummary | null> {
  const bizNo = sanitizeBizNo(input.bizNo);
  if (bizNo.length !== 10) {
    throw new KcomwelError(`Invalid business number for kcomwel lookup: ${input.bizNo}`);
  }
  const serviceKey = input.serviceKey?.trim();
  if (!serviceKey) {
    throw new KcomwelError("Missing kcomwel service key.");
  }
  const kind: KcomwelInsuranceKind = input.kind ?? "employment";
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildKcomwelUrl(serviceKey, bizNo, kind, input.numOfRows ?? 20);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/xml" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KcomwelError(
        `kcomwel 응답 시간 초과(${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms) · 게이트웨이 무응답`,
        error,
      );
    }
    throw new KcomwelError(`kcomwel request failed: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // 502(백엔드 포워딩 실패) 포함. 본문 앞부분을 사유에 담아 하네스가 표시한다.
    const body = await response.text().catch(() => "");
    throw new KcomwelError(
      `kcomwel request returned HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }

  let xml: string;
  try {
    xml = await response.text();
  } catch (error) {
    throw new KcomwelError(`kcomwel response body read failed: ${errorText(error)}`, error);
  }

  return parseKcomwelEmployment(xml, kind);
}

/**
 * kcomwel 응답 XML을 요약으로 파싱한다(순수 함수, 단위 테스트 가능).
 * - resultCode 가 정상(00/빈값)이 아니고 사업장도 없으면 KcomwelError.
 * - item 이 하나도 없으면 null(정상 음성 응답).
 */
export function parseKcomwelEmployment(
  xml: string,
  kind: KcomwelInsuranceKind,
): KcomwelEmploymentSummary | null {
  const sites = parseKcomwelSites(xml);
  if (sites.length === 0) {
    // 서비스 게이트웨이 오류 봉투(인증키 미등록 등): <returnAuthMsg>/<returnReasonCode>.
    const authMsg = extractTag(xml, "returnAuthMsg");
    const reasonCode = extractTag(xml, "returnReasonCode");
    if (authMsg || (reasonCode && reasonCode !== "00")) {
      throw new KcomwelError(
        `kcomwel service error${reasonCode ? ` reasonCode=${reasonCode}` : ""}${authMsg ? ` (${authMsg})` : ""}`,
      );
    }
    const resultCode = extractTag(xml, "resultCode");
    // 00/03(정상·데이터없음)이 아니고 아이템도 없으면 오류로 취급.
    if (resultCode && !["00", "03", "99"].includes(resultCode)) {
      const message = extractTag(xml, "resultMsg") ?? extractTag(xml, "errMsg");
      throw new KcomwelError(
        `kcomwel returned resultCode=${resultCode}${message ? ` (${message})` : ""}`,
      );
    }
    return null;
  }
  return summarizeKcomwelSites(sites, kind);
}

/** XML 문서에서 모든 <item> 블록을 추출해 사이트 배열로 파싱한다. */
export function parseKcomwelSites(xml: string): KcomwelSite[] {
  const sites: KcomwelSite[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? "";
    sites.push({
      saeopjangNm: extractTag(block, "saeopjangNm") ?? null,
      sangsiInwonCnt: integerOrNull(extractTag(block, "sangsiInwonCnt")),
      addr: extractTag(block, "addr") ?? null,
      seongripDt: digitsOrNull(extractTag(block, "seongripDt")),
      gyEopjongNm: extractTag(block, "gyEopjongNm") ?? null,
    });
  }
  return sites;
}

/** 사이트 배열을 사업자번호 1건 요약으로 접는다(합산·최소성립일). */
export function summarizeKcomwelSites(
  sites: KcomwelSite[],
  kind: KcomwelInsuranceKind,
): KcomwelEmploymentSummary {
  let totalWorkers: number | null = null;
  for (const site of sites) {
    if (typeof site.sangsiInwonCnt === "number") {
      totalWorkers = (totalWorkers ?? 0) + site.sangsiInwonCnt;
    }
  }
  const seongripDates = sites
    .map((site) => site.seongripDt)
    .filter((value): value is string => Boolean(value));
  const earliestSeongripDt =
    seongripDates.length > 0 ? seongripDates.slice().sort()[0]! : null;
  const primarySiteName = sites.find((site) => site.saeopjangNm)?.saeopjangNm ?? null;
  return {
    kind,
    siteCount: sites.length,
    totalWorkers,
    earliestSeongripDt,
    primarySiteName,
    insuranceActive: sites.length > 0,
  };
}

/** kcomwel 엔드포인트 URL을 만든다. serviceKey 이중 인코딩 방지(원문/인코딩 자동 판별). */
export function buildKcomwelUrl(
  serviceKey: string,
  bizNo: string,
  kind: KcomwelInsuranceKind,
  numOfRows: number,
): string {
  const params = [
    `serviceKey=${encodeServiceKey(serviceKey)}`,
    `v_saeopjaDrno=${encodeURIComponent(bizNo)}`,
    `opaBoheomFg=${OPA_BOHEOM_FG[kind]}`,
    `numOfRows=${encodeURIComponent(String(numOfRows))}`,
    "pageNo=1",
  ].join("&");
  return `${KCOMWEL_ENDPOINT}?${params}`;
}

function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  const unwrapped = raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1").trim();
  return unwrapped.length > 0 ? unwrapped : undefined;
}

function encodeServiceKey(serviceKey: string): string {
  return /%[0-9A-Fa-f]{2}/.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

function sanitizeBizNo(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

function integerOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function digitsOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

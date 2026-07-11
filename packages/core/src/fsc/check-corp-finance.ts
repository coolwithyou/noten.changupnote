/**
 * 금융위원회 기업 재무정보(요약재무제표) — 공공데이터포털 OpenAPI(15043459) V2.
 *
 * 법인등록번호(crno)로 연도별 요약재무제표(매출·부채·자본·자산·부채비율)를 조회한다. 무료.
 * 팝빌·국세청에 없는 revenue·financial_health(법인)를 무동의로 보강한다.
 * 조회키가 사업자번호가 아니라 **법인등록번호**라서 호출부에서 브리지가 필요하다(없으면 skip).
 * 호출부에서 fail-open으로 다뤄야 하므로 전송/HTTP/파싱 실패 시 throw 한다.
 *
 * 엔드포인트(실측 2026-07-11, 삼성전자 crno=1301110006246 로 실응답 확인):
 *   GET http://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2
 *     ?serviceKey={key}&crno=<법인등록번호 13자리>&numOfRows=&pageNo=&resultType=json
 *
 * 응답(JSON): response.body.items.item[] — 연도·재무제표구분별 1행. 실측 원문 필드:
 *   basDt(기준일자 YYYYMMDD) · crno · bizYear(사업연도) · fnclDcd(110 연결/120 별도)
 *   · fnclDcdNm · enpSaleAmt(매출액) · enpBzopPft(영업이익) · iclsPalClcAmt(세전손익)
 *   · enpCrtmNpf(당기순이익) · enpTastAmt(자산총계) · enpTdbtAmt(부채총계)
 *   · enpTcptAmt(자본총계) · enpCptlAmt(자본금) · fnclDebtRto(부채비율%) · curCd(통화)
 */

const FSC_CORP_FINANCE_ENDPOINT =
  "http://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2";
const DEFAULT_TIMEOUT_MS = 5_000;

/** 응답 item 1행(요약재무제표, 원문 필드명). 값은 문자열(원 단위). */
export interface FscCorpFinanceItem {
  basDt?: string;
  crno?: string;
  bizYear?: string;
  fnclDcd?: string;
  fnclDcdNm?: string;
  enpSaleAmt?: string;
  enpBzopPft?: string;
  iclsPalClcAmt?: string;
  enpCrtmNpf?: string;
  enpTastAmt?: string;
  enpTdbtAmt?: string;
  enpTcptAmt?: string;
  enpCptlAmt?: string;
  fnclDebtRto?: string;
  curCd?: string;
}

/** 최신 연도 1건으로 접은 요약(금액은 원 단위 number). */
export interface FscCorpFinanceSummary {
  /** 사업연도(YYYY). */
  bizYear: string | null;
  /** 기준일자 YYYYMMDD. */
  basDt: string | null;
  /** 재무제표구분명(별도/연결). */
  fnclDcdNm: string | null;
  /** 매출액(원). */
  saleAmt: number | null;
  /** 영업이익(원). */
  operatingProfit: number | null;
  /** 당기순이익(원). */
  netIncome: number | null;
  /** 자산총계(원). */
  totalAssets: number | null;
  /** 부채총계(원). */
  totalLiabilities: number | null;
  /** 자본총계(원). */
  totalEquity: number | null;
  /** 자본금(원). 0/누락이면 null. */
  capital: number | null;
  /** 부채비율(%). 응답값 우선, 없으면 부채/자본×100 계산. */
  debtRatioPct: number | null;
  /** 자본잠식(자본총계 ≤ 0). */
  impaired: boolean;
  /** 통화코드. */
  currency: string | null;
}

export interface CheckFscCorpFinanceInput {
  /** 공공데이터포털 인증키. */
  serviceKey: string;
  /** 법인등록번호(13자리, 하이픈 허용 — 내부에서 숫자만 추출). */
  corpRegNo: string;
  /** 목록 건수(여러 연도). 기본 30. */
  numOfRows?: number;
  /** 요청 타임아웃(ms). 기본 5000ms. */
  timeoutMs?: number;
  /** 테스트용 fetch 주입(기본 global fetch). */
  fetchImpl?: typeof fetch;
}

export class FscCorpFinanceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FscCorpFinanceError";
  }
}

/**
 * 기업 요약재무제표를 조회하고 최신 연도 1건으로 접어 반환한다.
 * - item 이 하나도 없으면 null(해당 법인 재무 데이터 없음).
 * - HTTP 오류/파싱 실패/API 오류코드 시 FscCorpFinanceError throw(호출부 fail-open).
 */
export async function checkFscCorpFinance(
  input: CheckFscCorpFinanceInput,
): Promise<FscCorpFinanceSummary | null> {
  const crno = sanitizeDigits(input.corpRegNo);
  if (crno.length !== 13) {
    throw new FscCorpFinanceError(`Invalid corporate registration number: ${input.corpRegNo}`);
  }
  const serviceKey = input.serviceKey?.trim();
  if (!serviceKey) {
    throw new FscCorpFinanceError("Missing FSC finance service key.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildFscCorpFinanceUrl(serviceKey, crno, input.numOfRows ?? 30);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new FscCorpFinanceError(`FSC corp finance request failed: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new FscCorpFinanceError(
      `FSC corp finance returned HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new FscCorpFinanceError(`FSC corp finance response was not valid JSON: ${errorText(error)}`, error);
  }

  return parseFscCorpFinance(payload);
}

/**
 * FSC 요약재무제표 응답을 최신 연도 요약으로 파싱한다(순수 함수).
 * - resultCode 가 정상(00)이 아니면 error.
 * - item 이 없으면 null.
 */
export function parseFscCorpFinance(payload: unknown): FscCorpFinanceSummary | null {
  const resultCode = extractResultCode(payload);
  if (resultCode && resultCode !== "00") {
    const msg = extractResultMsg(payload);
    throw new FscCorpFinanceError(`FSC corp finance resultCode=${resultCode}${msg ? ` (${msg})` : ""}`);
  }
  const items = extractItems(payload);
  if (items.length === 0) return null;
  const latest = selectLatestCorpFinance(items);
  if (!latest) return null;
  return summarizeCorpFinance(latest);
}

/** 최신 연도(basDt/bizYear 최대) 1건을 고른다. 동일 연도는 별도(120)→연결(110) 우선. */
export function selectLatestCorpFinance(items: FscCorpFinanceItem[]): FscCorpFinanceItem | null {
  if (items.length === 0) return null;
  const rank = (item: FscCorpFinanceItem): number => {
    // 별도재무제표(120) 우선(단일 법인 실체), 그다음 연결(110), 그 외.
    if (item.fnclDcd === "120") return 2;
    if (item.fnclDcd === "110") return 1;
    return 0;
  };
  const yearKey = (item: FscCorpFinanceItem): string => item.basDt ?? item.bizYear ?? "";
  return items
    .slice()
    .sort((a, b) => {
      const cmp = yearKey(b).localeCompare(yearKey(a));
      if (cmp !== 0) return cmp;
      return rank(b) - rank(a);
    })[0] ?? null;
}

/** item 1건을 금액 number 요약으로 정규화한다(자본잠식·부채비율 파생 포함). */
export function summarizeCorpFinance(item: FscCorpFinanceItem): FscCorpFinanceSummary {
  const totalLiabilities = wonOrNull(item.enpTdbtAmt);
  const totalEquity = wonOrNull(item.enpTcptAmt);
  const capital = positiveWonOrNull(item.enpCptlAmt);
  const debtRatioResponse = floatOrNull(item.fnclDebtRto);
  const debtRatioPct =
    debtRatioResponse ??
    (totalLiabilities !== null && totalEquity !== null && totalEquity > 0
      ? Math.round((totalLiabilities / totalEquity) * 1000) / 10
      : null);
  return {
    bizYear: item.bizYear ?? null,
    basDt: item.basDt ?? null,
    fnclDcdNm: item.fnclDcdNm ?? null,
    saleAmt: wonOrNull(item.enpSaleAmt),
    operatingProfit: wonOrNull(item.enpBzopPft),
    netIncome: wonOrNull(item.enpCrtmNpf),
    totalAssets: wonOrNull(item.enpTastAmt),
    totalLiabilities,
    totalEquity,
    capital,
    debtRatioPct,
    impaired: totalEquity !== null && totalEquity <= 0,
    currency: item.curCd ?? null,
  };
}

export function buildFscCorpFinanceUrl(serviceKey: string, crno: string, numOfRows: number): string {
  const params = [
    `serviceKey=${encodeServiceKey(serviceKey)}`,
    `crno=${encodeURIComponent(crno)}`,
    `numOfRows=${encodeURIComponent(String(numOfRows))}`,
    "pageNo=1",
    "resultType=json",
  ].join("&");
  return `${FSC_CORP_FINANCE_ENDPOINT}?${params}`;
}

// ── 응답 탐색 헬퍼(JSON 구조 response.body.items.item[] / header.resultCode) ──

function extractItems(payload: unknown): FscCorpFinanceItem[] {
  const body = getPath(payload, ["response", "body"]);
  const items = getPath(body, ["items", "item"]);
  if (Array.isArray(items)) return items as FscCorpFinanceItem[];
  if (items && typeof items === "object") return [items as FscCorpFinanceItem];
  return [];
}

function extractResultCode(payload: unknown): string | null {
  const code = getPath(payload, ["response", "header", "resultCode"]);
  return typeof code === "string" ? code : null;
}

function extractResultMsg(payload: unknown): string | null {
  const msg = getPath(payload, ["response", "header", "resultMsg"]);
  return typeof msg === "string" ? msg : null;
}

function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function encodeServiceKey(serviceKey: string): string {
  return /%[0-9A-Fa-f]{2}/.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

function sanitizeDigits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

function wonOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function positiveWonOrNull(value: string | undefined): number | null {
  const won = wonOrNull(value);
  return won !== null && won > 0 ? won : null;
}

function floatOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

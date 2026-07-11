/**
 * NICE BizAPI OCOV06 [기업]개요-주요경영지표 — 최근 5개년 요약재무를 최신 1건으로 접는다.
 *
 * 사업자번호(companyKey)를 URL path 세그먼트로 넣어 조회한다(법인등록번호 브리지 불필요).
 *   GET {BASE}/company/overview/{companyKey}/indicator?tpCd=01&fatpCd=0
 *
 * 응답 봉투: { request, data: { listCount, indicatorMetricsList[] } }.
 * indicatorMetricsList 각 항목은 한 회계연도(stacDate YYYYMMDD)의 지표이며 **금액 단위=천원**이다.
 * (실측 2026-07-11: 삼성전자 salesFvl "238043009000"(천원) × 1000 = 238,043,009,000,000원 = 238조.)
 *
 * 정규화 규칙: 금액은 천원×1000 으로 원 단위 number 로 환산, 부채비율/자본잠식 파생.
 * 데이터 없음(listCount 0 / 빈 배열)이면 null.
 */

import { callOpenGate, extractData } from "./opengate-client.js";
import type { CallOpenGateInput } from "./opengate-client.js";

/** OCOV06 indicatorMetricsList 한 항목(원문 필드명, 금액은 천원 단위 문자열). */
export interface NiceIndicatorMetric {
  /** 재무결산일자 YYYYMMDD. */
  stacDate?: string;
  /** 자산총액(천원). */
  aettamt?: string;
  /** 부채총계(천원). */
  dbtTtlFvl?: string;
  /** 자본총계(천원). */
  fdsTtlFvl?: string;
  /** 매출액(천원). */
  salesFvl?: string;
  /** 영업이익(천원). */
  slsprftFvl?: string;
  /** 순이익(천원). */
  nrf?: string;
  /** 감사의견 목록. */
  auditOptionList?: Array<{ auditKornm?: string; auditEngnm?: string; auditor?: string }>;
}

/** 최신 연도 1건으로 접은 요약(금액은 원 단위 number). */
export interface NiceIndicatorSummary {
  /** 사업연도(stacDate 앞 4자리). */
  bizYear: string | null;
  /** 재무결산일자 YYYYMMDD. */
  stacDate: string | null;
  /** 매출액(원). */
  revenueWon: number | null;
  /** 자산총계(원). */
  totalAssetsWon: number | null;
  /** 자본총계(원). */
  totalEquityWon: number | null;
  /** 부채총계(원). */
  totalLiabilitiesWon: number | null;
  /** 영업이익(원). */
  operatingProfitWon: number | null;
  /** 순이익(원). */
  netIncomeWon: number | null;
  /** 부채비율(%). 자본총계>0 일 때만 부채/자본×100(소수1자리). */
  debtRatioPct: number | null;
  /** 자본잠식(자본총계 ≤ 0). */
  impaired: boolean;
  /** 최신 연도 감사의견(auditKornm). */
  auditOpinion: string | null;
}

export interface CheckNiceCorpIndicatorInput {
  /** 클라이언트 앱키(NICE_BIZ_CLIENT_APP_KEY). */
  appKey: string;
  /** 클라이언트 시크릿(NICE_BIZ_CLIENT_SECRET). */
  secret: string;
  /** 조회 companyKey(사업자번호 10자리/법인번호 13자리, 하이픈 허용 — 내부에서 숫자만 추출). */
  companyKey: string;
  /** 회계기준구분(KGAAP=01, IFRS=02). 기본 01. */
  tpCd?: string;
  /** 재무유형코드(개별=0, 연결=1). 기본 0. */
  fatpCd?: string;
  /** 요청 타임아웃(ms). */
  timeoutMs?: number;
  /** 테스트용 fetch 주입. */
  fetchImpl?: typeof fetch;
}

/**
 * OCOV06 주요경영지표를 조회하고 최신 연도 1건으로 접어 반환한다.
 * - 데이터 없음(listCount 0/빈 배열) → null.
 * - HTTP/네트워크/파싱 실패 시 NiceBizError throw(403 은 NiceBizNotProvisionedError).
 */
export async function checkNiceCorpIndicator(
  input: CheckNiceCorpIndicatorInput,
): Promise<NiceIndicatorSummary | null> {
  const companyKey = sanitizeDigits(input.companyKey);
  const payload = await callOpenGate({
    appKey: input.appKey,
    secret: input.secret,
    path: `/company/overview/${companyKey}/indicator`,
    query: { tpCd: input.tpCd ?? "01", fatpCd: input.fatpCd ?? "0" },
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  } satisfies CallOpenGateInput);
  return parseNiceIndicator(payload);
}

/**
 * OCOV06 응답을 최신 연도 요약으로 파싱한다(순수 함수).
 * - indicatorMetricsList 가 비었으면 null.
 */
export function parseNiceIndicator(payload: unknown): NiceIndicatorSummary | null {
  const data = extractData(payload);
  const list = data?.["indicatorMetricsList"];
  const metrics: NiceIndicatorMetric[] = Array.isArray(list) ? (list as NiceIndicatorMetric[]) : [];
  if (metrics.length === 0) return null;
  const latest = selectLatestIndicator(metrics);
  if (!latest) return null;
  return summarizeIndicator(latest);
}

/** stacDate(YYYYMMDD) 내림차순으로 정렬해 최신 연도 1건을 고른다. */
export function selectLatestIndicator(
  metrics: NiceIndicatorMetric[],
): NiceIndicatorMetric | null {
  if (metrics.length === 0) return null;
  return (
    metrics
      .slice()
      .sort((a, b) => (b.stacDate ?? "").localeCompare(a.stacDate ?? ""))[0] ?? null
  );
}

/** metric 1건을 원 단위 요약으로 정규화한다(천원×1000, 부채비율·자본잠식 파생). */
export function summarizeIndicator(metric: NiceIndicatorMetric): NiceIndicatorSummary {
  const totalLiabilitiesWon = thousandWonToWon(metric.dbtTtlFvl);
  const totalEquityWon = thousandWonToWon(metric.fdsTtlFvl);
  const stacDate = metric.stacDate ?? null;
  return {
    bizYear: stacDate && stacDate.length >= 4 ? stacDate.slice(0, 4) : null,
    stacDate,
    revenueWon: thousandWonToWon(metric.salesFvl),
    totalAssetsWon: thousandWonToWon(metric.aettamt),
    totalEquityWon,
    totalLiabilitiesWon,
    operatingProfitWon: thousandWonToWon(metric.slsprftFvl),
    netIncomeWon: thousandWonToWon(metric.nrf),
    debtRatioPct:
      totalLiabilitiesWon !== null && totalEquityWon !== null && totalEquityWon > 0
        ? Math.round((totalLiabilitiesWon / totalEquityWon) * 1000) / 10
        : null,
    impaired: totalEquityWon !== null && totalEquityWon <= 0,
    auditOpinion: firstAuditOpinion(metric.auditOptionList),
  };
}

/** 천원 단위 문자열을 원 단위 number 로 환산(×1000). 파싱 불가 시 null. */
function thousandWonToWon(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number * 1000 : null;
}

function firstAuditOpinion(
  list: NiceIndicatorMetric["auditOptionList"],
): string | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const opinion = entry?.auditKornm?.trim();
    if (opinion) return opinion;
  }
  return null;
}

function sanitizeDigits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

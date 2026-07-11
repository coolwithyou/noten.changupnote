/**
 * NICE BizAPI 기업 신용 오퍼레이션 3종 — OCCD03(신용도판단정보)·OCCD06(법정관리/워크아웃)·OCCD01(신용요약).
 *
 *   OCCD03: GET {BASE}/company/credit/{companyKey}/negativeInfo
 *   OCCD06: GET {BASE}/company/credit/{companyKey}/workout
 *   OCCD01: GET {BASE}/company/credit/{companyKey}/summary   (테스트앱 미프로비저닝 → HTTP 403)
 *
 * `checkNiceCorpCredit` 는 세 오퍼레이션을 **독립적으로** 호출해(하나가 실패해도 나머지는 채움)
 * per-operation ok/error/notProvisioned 를 담은 요약을 반환한다. 순수 파서는 단위 테스트 대상이다.
 * OCCD03 listCount 0 = 결격 없음(clean), OCCD06 빈 리스트 = 법정관리/워크아웃 없음.
 */

import { callOpenGate, extractData, NiceBizNotProvisionedError } from "./opengate-client.js";
import type { CallOpenGateInput } from "./opengate-client.js";

// ── OCCD03 신용도판단정보 ─────────────────────────────────────────────────────

/** 유형별 카운트(없으면 0). BB=채무불이행, FD=금융질서문란, PB=공공정보, SB=특수기록. */
export interface NiceNegativeCounts {
  /** 채무불이행 건수(bbCnt). */
  bb: number;
  /** 금융질서문란 건수(fdCnt). */
  fd: number;
  /** 공공기록정보 건수(pbCnt · 국세/지방세 체납 등, 국세·지방세 미분리 집계). */
  pb: number;
  /** 특수기록정보 건수(sbCnt). */
  sb: number;
  /** 발생 총건수(totaloccCnt). */
  totalOcc: number;
}

/** 신용도판단정보 상세 1건(선택). */
export interface NiceNegativeDetail {
  /** 유형구분코드(BB/FD/PB/SB). */
  typecode: string | null;
  /** 등록사유명. */
  causename: string | null;
}

/** OCCD03 파싱 결과. */
export interface NiceNegativeInfo {
  counts: NiceNegativeCounts;
  details: NiceNegativeDetail[];
  listCount: number;
}

// ── OCCD06 법정관리/워크아웃 ──────────────────────────────────────────────────

/** 법정관리/워크아웃 1건. */
export interface NiceLegalManagementItem {
  /** 법정관리유형명(lglmgmtdivnm). */
  divName: string | null;
  /** 법원명(lwcnm). */
  courtName: string | null;
  /** 법정관리관계일자 YYYYMMDD(lglmgmtRldDate). */
  date: string | null;
  /** 사건번호(hngno). */
  caseNo: string | null;
}

/** OCCD06 파싱 결과. */
export interface NiceWorkoutInfo {
  /** 법정관리/워크아웃 건수(totalCount 우선, 없으면 리스트 길이). */
  count: number;
  items: NiceLegalManagementItem[];
}

// ── OCCD01 신용요약(미프로비저닝) ────────────────────────────────────────────

/** OCCD01 파싱 결과(프로비저닝 시). */
export interface NiceCreditSummaryInfo {
  /** 당좌거래정지정보 건수(suspensionInfoCnt). */
  suspensionInfoCnt: number | null;
  /** 법정관리/워크아웃정보 건수(workoutCnt). */
  workoutCnt: number | null;
}

/** 오퍼레이션 1건의 결과 봉투(부분 성공 허용). */
export interface NiceOperationResult<T> {
  /** HTTP 200 + 파싱 성공. */
  ok: boolean;
  /** 파싱된 데이터(실패 시 null). */
  data: T | null;
  /** 실패 사유(있으면). */
  error?: string;
  /** 미프로비저닝(HTTP 403)이면 true → 호출부는 skip 처리. */
  notProvisioned?: boolean;
}

/** checkNiceCorpCredit 종합 결과. */
export interface NiceCreditSummary {
  /** OCCD03 신용도판단정보. */
  negative: NiceOperationResult<NiceNegativeInfo>;
  /** OCCD06 법정관리/워크아웃. */
  workout: NiceOperationResult<NiceWorkoutInfo>;
  /** OCCD01 신용요약(테스트앱 미프로비저닝 예상). */
  summary: NiceOperationResult<NiceCreditSummaryInfo>;
}

export interface CheckNiceCorpCreditInput {
  appKey: string;
  secret: string;
  /** 조회 companyKey(사업자번호 10자리, 하이픈 허용). */
  companyKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OCCD03·OCCD06·OCCD01 을 독립적으로 호출한다. 하나가 실패해도 나머지는 채운다(부분 성공).
 * 절대 throw 하지 않고 per-operation error/notProvisioned 로 실패를 노출한다.
 */
export async function checkNiceCorpCredit(
  input: CheckNiceCorpCreditInput,
): Promise<NiceCreditSummary> {
  const companyKey = sanitizeDigits(input.companyKey);
  const base = {
    appKey: input.appKey,
    secret: input.secret,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  };

  const [negative, workout, summary] = await Promise.all([
    runOp(() =>
      callOpenGate({
        ...base,
        path: `/company/credit/${companyKey}/negativeInfo`,
      } satisfies CallOpenGateInput),
    ).then((r) => mapOp(r, parseNiceNegativeInfo)),
    runOp(() =>
      callOpenGate({
        ...base,
        path: `/company/credit/${companyKey}/workout`,
      } satisfies CallOpenGateInput),
    ).then((r) => mapOp(r, parseNiceWorkout)),
    runOp(() =>
      callOpenGate({
        ...base,
        path: `/company/credit/${companyKey}/summary`,
      } satisfies CallOpenGateInput),
    ).then((r) => mapOp(r, parseNiceCreditSummary)),
  ]);

  return { negative, workout, summary };
}

type RawOp = { payload: unknown } | { error: string; notProvisioned: boolean };

async function runOp(fn: () => Promise<unknown>): Promise<RawOp> {
  try {
    return { payload: await fn() };
  } catch (error) {
    return {
      error: errorText(error).slice(0, 160),
      notProvisioned: error instanceof NiceBizNotProvisionedError,
    };
  }
}

function mapOp<T>(raw: RawOp, parse: (payload: unknown) => T): NiceOperationResult<T> {
  if ("error" in raw) {
    return {
      ok: false,
      data: null,
      error: raw.error,
      ...(raw.notProvisioned ? { notProvisioned: true } : {}),
    };
  }
  try {
    return { ok: true, data: parse(raw.payload) };
  } catch (error) {
    return { ok: false, data: null, error: errorText(error).slice(0, 160) };
  }
}

/** OCCD03 응답을 카운트·상세로 파싱한다(순수 함수). 데이터 없음이면 카운트 전부 0. */
export function parseNiceNegativeInfo(payload: unknown): NiceNegativeInfo {
  const data = extractData(payload);
  const list = data?.["creditNegativeInfoList"];
  const rows = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  const listCount = intOrZero(data?.["listCount"]);
  if (rows.length === 0) {
    return { counts: emptyCounts(), details: [], listCount };
  }
  const first = rows[0] ?? {};
  const counts: NiceNegativeCounts = {
    bb: intOrZero(first["bbCnt"]),
    fd: intOrZero(first["fdCnt"]),
    pb: intOrZero(first["pbCnt"]),
    sb: intOrZero(first["sbCnt"]),
    totalOcc: intOrZero(first["totaloccCnt"]),
  };
  const detailList = first["negativeInfoDetailList"];
  const details: NiceNegativeDetail[] = Array.isArray(detailList)
    ? (detailList as Array<Record<string, unknown>>).map((d) => ({
        typecode: strOrNull(d["typecode"]),
        causename: strOrNull(d["causename"]),
      }))
    : [];
  return { counts, details, listCount };
}

/** OCCD06 응답을 법정관리/워크아웃 목록으로 파싱한다(순수 함수). 빈 리스트면 count 0. */
export function parseNiceWorkout(payload: unknown): NiceWorkoutInfo {
  const data = extractData(payload);
  const list = data?.["creditWorkoutList"];
  const rows = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  const totalCount = data?.["totalCount"];
  const count =
    typeof totalCount === "number" && Number.isFinite(totalCount) ? totalCount : rows.length;
  const items: NiceLegalManagementItem[] = rows.map((r) => ({
    divName: strOrNull(r["lglmgmtdivnm"]),
    courtName: strOrNull(r["lwcnm"]),
    date: strOrNull(r["lglmgmtRldDate"]),
    caseNo: strOrNull(r["hngno"]),
  }));
  return { count, items };
}

/** OCCD01 응답을 신용요약으로 파싱한다(프로비저닝 시). 빈 리스트면 카운트 null. */
export function parseNiceCreditSummary(payload: unknown): NiceCreditSummaryInfo {
  const data = extractData(payload);
  const list = data?.["creditSummaryList"];
  const rows = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  const first = rows[0];
  if (!first) return { suspensionInfoCnt: null, workoutCnt: null };
  return {
    suspensionInfoCnt: intOrNull(first["suspensionInfoCnt"]),
    workoutCnt: intOrNull(first["workoutCnt"]),
  };
}

function emptyCounts(): NiceNegativeCounts {
  return { bb: 0, fd: 0, pb: 0, sb: 0, totalOcc: 0 };
}

function intOrZero(value: unknown): number {
  const n = intOrNull(value);
  return n ?? 0;
}

function intOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeDigits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

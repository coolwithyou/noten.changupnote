/**
 * CODEF 홈택스 부가가치세 과세표준증명 — 요청 빌더 + 응답 정규화.
 *
 * 경로: POST /v1/kr/public/nt/proof-issue/additional-taxstandard.
 * 같은 id(세션 SSO)로 사업자등록증명에 이어 호출한다. 과세표준(≈매출 근사)을 원 단위 정수로 뽑는다.
 * 간이/면세 개인 등 신고 이력이 없으면 빈 응답 → taxBaseWon=null(hasFiling=false).
 *
 * 주의: 실제 응답 필드명은 D1 라이브 런에서 확정한다. 여기서는 후보 키를 넓게 탐색하고,
 * 목록형(연도별 엔트리)은 과세표준을 합산하며 최신 연도를 기록한다.
 */

import { buildSimpleAuthBody } from "../request-params.js";
import type { SimpleAuthLoginInput } from "../request-params.js";

/** 부가세과세표준증명 상품 경로. */
export const VAT_BASE_CERTIFICATE_PATH =
  "/v1/kr/public/nt/proof-issue/additional-taxstandard";

/** 과세표준 후보 필드명(top-level·엔트리 공용). D1에서 실측 확정 전 넓게 탐색. */
const TAX_BASE_AMOUNT_KEYS = [
  "resTaxStandard",
  "resTaxbaseTotAmt",
  "resTaxBase",
  "resSupplyAmount",
  "resAmount",
] as const;

/** 연도별 과세표준 목록 후보 필드명. */
const TAX_BASE_LIST_KEYS = ["resTaxStandardList", "resTaxAmountList", "resItemList"] as const;

/** 기준연도 후보 필드명. */
const TAX_BASE_YEAR_KEYS = ["resStandardYear", "resYear", "resBaseYear"] as const;

/** 부가세과세표준 정규화 결과. */
export interface VatBaseFacts {
  /** 과세표준 합계(원 단위 정수, 매출 근사). 신고 이력 없으면 null. */
  taxBaseWon: number | null;
  /** 최신 기준연도 yyyy(있으면). */
  year: string | null;
  /** 신고 이력 존재 여부(빈 응답 구분용). */
  hasFiling: boolean;
}

/**
 * 부가세과세표준증명 요청 body를 조립한다(간편인증 파라미터, 사업자등록증명과 동형·같은 id 세션 SSO 전제).
 */
export function buildVatBaseRequest(input: SimpleAuthLoginInput): Record<string, unknown> {
  return buildSimpleAuthBody(input);
}

/**
 * 부가세과세표준 성공 응답 data를 정규화한다(순수).
 * - 목록형: 엔트리별 과세표준 합산 + 최신 연도.
 * - 단일형: top-level 과세표준.
 * - 신고 이력 없음(빈 응답) → taxBaseWon=null, hasFiling=false.
 * - data가 아예 없으면 null.
 */
export function normalizeVatBase(data: unknown): VatBaseFacts | null {
  const rec = asRecord(data);
  if (!rec) return null;

  // 1) 목록형: 연도별 과세표준 엔트리 합산.
  const list = pickArray(rec, TAX_BASE_LIST_KEYS);
  if (list) {
    let sum = 0;
    let found = false;
    let latestYear: string | null = null;
    for (const entryRaw of list) {
      const entry = asRecord(entryRaw);
      if (!entry) continue;
      const amount = pickWon(entry, TAX_BASE_AMOUNT_KEYS);
      if (amount !== null) {
        sum += amount;
        found = true;
      }
      const year = pickYear(entry, TAX_BASE_YEAR_KEYS);
      if (year && (latestYear === null || year > latestYear)) latestYear = year;
    }
    return found
      ? { taxBaseWon: sum, year: latestYear, hasFiling: true }
      : { taxBaseWon: null, year: latestYear, hasFiling: false };
  }

  // 2) 단일형: top-level 과세표준.
  const single = pickWon(rec, TAX_BASE_AMOUNT_KEYS);
  const year = pickYear(rec, TAX_BASE_YEAR_KEYS);
  return single === null
    ? { taxBaseWon: null, year, hasFiling: false }
    : { taxBaseWon: single, year, hasFiling: true };
}

function pickArray(
  rec: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | null {
  for (const key of keys) {
    const value = rec[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function pickWon(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    if (key in rec) {
      const won = parseWon(rec[key]);
      if (won !== null) return won;
    }
  }
  return null;
}

function pickYear(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const match = /\d{4}/.exec(String(value));
    if (match) return match[0];
  }
  return null;
}

/** "1,234,000원" / "1234000" → 1234000. 파싱 불가/빈값 → null. */
function parseWon(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^\d-]/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * CODEF 홈택스 사업자등록증명 — 요청 빌더 + 응답 정규화.
 *
 * 경로: POST /v1/kr/public/nt/proof-issue/corporate-registration (24시간 발급 가능).
 * 간편인증 파라미터(loginType="5")로 요청하고, 성공 응답 data에서 원문 필드를 보존해 뽑는다.
 *
 * industry: resBusinessTypes(업태)/resBusinessItems(종목) 텍스트가 주 경로다.
 *   resBusinessTypeCode는 "데이터 보장 불가"라 코드 기반을 신뢰하지 않는다.
 * 개인정보: resUserIdentiyNo(주민/법인번호)는 **철자 그대로**(원문 오타 유지) 받되, 저장 시 마스킹한다.
 */

import { buildSimpleAuthBody } from "../request-params.js";
import type { SimpleAuthLoginInput } from "../request-params.js";

/** 사업자등록증명 상품 경로. */
export const CORPORATE_REGISTRATION_PATH =
  "/v1/kr/public/nt/proof-issue/corporate-registration";

/** 사업자등록증명 정규화 결과(원문 필드 보존, 식별번호는 마스킹). */
export interface CorporateRegistrationFacts {
  /** 상호/성명(resUserNm). */
  resUserNm: string | null;
  /** 사업장 주소(resUserAddr). */
  resUserAddr: string | null;
  /** 개업일 yyyyMMdd(resOpenDate). */
  resOpenDate: string | null;
  /** 업태(resBusinessTypes). */
  resBusinessTypes: string | null;
  /** 종목(resBusinessItems). */
  resBusinessItems: string | null;
  /** 사업자종류 법인/개인(resBusinessmanType). */
  resBusinessmanType: string | null;
  /** 주민/법인번호(resUserIdentiyNo, 철자 그대로) — 마스킹 저장. */
  resUserIdentiyNo: string | null;
  /** 공동대표 성명(resJointRepresentativeNm). */
  resJointRepresentativeNm: string | null;
}

/**
 * 사업자등록증명 요청 body를 조립한다(간편인증 파라미터). id는 호출자가 세션 SSO 키로 주입.
 */
export function buildCorporateRegistrationRequest(
  input: SimpleAuthLoginInput,
): Record<string, unknown> {
  return buildSimpleAuthBody(input);
}

/**
 * 사업자등록증명 성공 응답 data를 정규화한다(순수). data가 없으면 null.
 * resUserIdentiyNo는 앞 6자리만 남기고 마스킹한다.
 */
export function normalizeCorporateRegistration(
  data: unknown,
): CorporateRegistrationFacts | null {
  const rec = asRecord(data);
  if (!rec) return null;
  return {
    resUserNm: strOrNull(rec["resUserNm"]),
    resUserAddr: strOrNull(rec["resUserAddr"]),
    resOpenDate: digitsOrNull(rec["resOpenDate"]),
    resBusinessTypes: strOrNull(rec["resBusinessTypes"]),
    resBusinessItems: strOrNull(rec["resBusinessItems"]),
    resBusinessmanType: strOrNull(rec["resBusinessmanType"]),
    resUserIdentiyNo: maskIdentityNo(strOrNull(rec["resUserIdentiyNo"])),
    resJointRepresentativeNm: strOrNull(rec["resJointRepresentativeNm"]),
  };
}

/** 식별번호에서 앞 6자리 숫자만 남기고 이후 숫자는 '*'로 마스킹한다(구분자는 보존). */
export function maskIdentityNo(value: string | null): string | null {
  if (!value) return null;
  let seenDigits = 0;
  let out = "";
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      seenDigits += 1;
      out += seenDigits <= 6 ? ch : "*";
    } else {
      out += ch;
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function digitsOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  return digits || null;
}

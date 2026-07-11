/**
 * CODEF 간편인증(loginType="5") 요청 파라미터 조립 — 홈택스 증명발급 상품 공용.
 *
 * 사업자등록증명·부가세과세표준증명 등 국세청 증명발급 상품은 동일한 간편인증 파라미터
 * 집합을 쓴다(같은 id로 세션 SSO). 여기서 공용 body 빌더와 상수를 둔다.
 *
 * 오픈 결정(D1 데모 키 라이브 런에서 실측 확인 필요):
 *  - organization(국세청/홈택스 기관코드): 기본 "0001" — TODO(D1) 실측 확인.
 *  - usePurposes/submitTargets: 기본 "99"(기타) — 정책 오픈 결정, TODO(D1) 확인.
 */

import { createHash } from "node:crypto";

/**
 * 국세청(홈택스) 기관코드.
 * TODO(D1): 데모 키 라이브 런에서 실측 확인(개발가이드 Vue SPA라 정적 대조 불가).
 */
export const CODEF_ORGANIZATION_NTS = "0001";

/** loginType — 회원 간편인증. */
export const CODEF_LOGIN_TYPE_SIMPLE_AUTH = "5";

/** isIdentityViewYN — 주민 뒷자리 비공개(개인정보 최소화). */
export const CODEF_IDENTITY_VIEW_HIDDEN = "0";

/**
 * usePurposes/submitTargets 기본값 "99"(기타).
 * TODO(D1): 필수 여부·허용 코드 세트를 데모 실측으로 확정.
 */
export const CODEF_USE_PURPOSE_OTHER = "99";
export const CODEF_SUBMIT_TARGET_OTHER = "99";

/**
 * loginTypeLevel — 간편인증 인증앱 코드 매핑(문서 실측).
 *  1:카카오톡 2:페이코 3:삼성패스 4:KB모바일 5:통신사(PASS) 6:네이버 7:신한인증서 8:toss.
 */
export const CODEF_SIMPLE_AUTH_APPS = {
  kakaotalk: "1",
  payco: "2",
  samsungPass: "3",
  kbMobile: "4",
  pass: "5",
  naver: "6",
  shinhan: "7",
  toss: "8",
} as const;

export type CodefSimpleAuthApp = keyof typeof CODEF_SIMPLE_AUTH_APPS;

/** 간편인증 상품 요청 입력(사업자등록증명·부가세과세표준 공용). */
export interface SimpleAuthLoginInput {
  /** 기관코드. 기본 국세청 CODEF_ORGANIZATION_NTS. */
  organization?: string;
  /** loginType. 기본 "5"(간편인증). */
  loginType?: string;
  /** 인증앱 코드(CODEF_SIMPLE_AUTH_APPS 값). 필수. */
  loginTypeLevel: string;
  /** 이름. */
  userName: string;
  /** 휴대폰번호(숫자만으로 정규화). */
  phoneNo: string;
  /** 생년월일 8자리 yyyyMMdd. */
  identity: string;
  /** 통신사 코드. loginTypeLevel="5"(PASS)일 때만 포함(조건부). */
  telecom?: string;
  /** isIdentityViewYN. 기본 "0"(주민 뒷자리 비공개). */
  isIdentityViewYN?: string;
  /** usePurposes. 기본 "99". */
  usePurposes?: string;
  /** submitTargets. 기본 "99". */
  submitTargets?: string;
  /** 세션 SSO 키(id). 호출자가 주입. buildCodefSessionId로 생성 가능. */
  id: string;
}

/**
 * 간편인증 공용 요청 body를 조립한다(순수). telecom은 PASS(loginTypeLevel="5")일 때만 조건부 포함.
 */
export function buildSimpleAuthBody(input: SimpleAuthLoginInput): Record<string, unknown> {
  const loginTypeLevel = input.loginTypeLevel;
  const body: Record<string, unknown> = {
    organization: input.organization ?? CODEF_ORGANIZATION_NTS,
    loginType: input.loginType ?? CODEF_LOGIN_TYPE_SIMPLE_AUTH,
    loginTypeLevel,
    userName: input.userName.trim(),
    phoneNo: sanitizeDigits(input.phoneNo),
    identity: sanitizeDigits(input.identity),
    isIdentityViewYN: input.isIdentityViewYN ?? CODEF_IDENTITY_VIEW_HIDDEN,
    usePurposes: input.usePurposes ?? CODEF_USE_PURPOSE_OTHER,
    submitTargets: input.submitTargets ?? CODEF_SUBMIT_TARGET_OTHER,
    id: input.id,
  };
  // telecom은 통신사(PASS) 간편인증에서만 필요 — 그 외 앱은 생략.
  const telecom = input.telecom?.trim();
  if (loginTypeLevel === CODEF_SIMPLE_AUTH_APPS.pass && telecom) {
    body["telecom"] = telecom;
  }
  return body;
}

/**
 * 세션 SSO 키(id)를 생성한다. 사용자ID+사업자번호를 SHA-256 해시해 안정적 키로 만든다
 * (같은 사용자·같은 사업자면 동일 id → 1회 인증 세션 다건 SSO).
 */
export function buildCodefSessionId(userId: string, bizNo: string): string {
  const digits = sanitizeDigits(bizNo);
  const hash = createHash("sha256").update(`${userId}:${digits}`).digest("hex");
  return `cunote-${hash.slice(0, 24)}`;
}

function sanitizeDigits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

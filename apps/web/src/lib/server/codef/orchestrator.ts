/**
 * CODEF 간편인증 오케스트레이터 (Phase B B3).
 *
 * serverless 에서 "승인 대기 → 완료"를 두 HTTP 요청으로 처리한다.
 *  - startSimpleAuth: 토큰 확보 → 사업자등록증명 1차 요청 → CF-03002면 세션 저장 후 pending 반환.
 *  - completeSimpleAuth: 사용자 앱 승인 후 호출. 사업자등록증명 2-way 완료 → 같은 id(세션 SSO)로
 *    부가세과세표준 연속 호출. VAT 는 SSO 양쪽 경로(1차 바로 성공 / 2차 승인 필요)를 모두 지원하고,
 *    상품 미신청(CF-00003 등)은 관용 처리해 사업자등록증명만으로 프로필을 완성한다.
 *
 * 코어(@cunote/core)의 순수 계약을 소비만 한다(코어 미수정). 프로덕션 serviceData 오버레이 미접촉.
 *
 * 마스킹(B5): 생년월일·전화·주민번호·토큰을 로그/에러메시지에 절대 출력하지 않는다. transactionId 만
 * 로깅한다. 세션 requestSnapshot(민감 로그인 입력)은 세션 종결 즉시 NULL(session-store 가 보장).
 */

import type { CompanyProfile } from "@cunote/contracts";
import {
  buildCodefSessionId,
  buildCompanyProfileFromCodef,
  buildCorporateRegistrationRequest,
  buildTwoWayRequestBody,
  buildVatBaseRequest,
  CODEF_SIMPLE_AUTH_APPS,
  CodefError,
  CORPORATE_REGISTRATION_PATH,
  defaultVatBaseDateRange,
  extractTwoWayInfo,
  normalizeCorporateRegistration,
  normalizeVatBase,
  readCodefEnvConfig,
  requestCodefProduct,
  requestCodefToken,
  VAT_BASE_CERTIFICATE_PATH,
  type CodefEnvConfig,
  type CodefSimpleAuthApp,
  type CorporateRegistrationFacts,
  type SimpleAuthLoginInput,
  type TwoWayInfo,
  type VatBaseFacts,
} from "@cunote/core";
import {
  createCodefSession,
  getCachedCodefToken,
  getCodefSession,
  setCachedCodefToken,
  transitionCodefSession,
  updateCodefSession,
  upsertCodefCompanyProfiles,
  upsertCodefEnrichmentCache,
  type CodefSessionRecord,
} from "./session-store";

const APPROVAL_GUIDE = "카카오톡 등 인증앱에서 승인한 뒤 완료를 눌러주세요.";
/** 미승인 재요청 최대 횟수(CF-12872 대비). 초과 시 실패로 종결. */
const MAX_APPROVAL_RETRY = 2;
/**
 * VAT SSO 기본 모드. true = 사업자등록증명 성공 직후 같은 id 로 VAT 1차를 바로 시도(SSO 성립 가정).
 * false 로 두면 VAT 1차를 건너뛰지 않되 튜닝 지점을 한 곳(D1 결과 반영)으로 남긴다.
 */
const CODEF_VAT_SSO_MODE = true;

// ── 입력/출력 타입 ────────────────────────────────────────────────────────────

export interface StartSimpleAuthInput {
  name: string;
  birth8: string;
  phone: string;
  telecom?: string;
  authApp: CodefSimpleAuthApp;
  gender?: "M" | "F" | null;
  /** 로그인 사용자 id(있으면 세션 SSO 키에 반영). dev 는 미지정 → "dev". */
  userId?: string | null;
}

/** UI 가 소비하는 국세청 확정값 요약(생년월일 원본·주민번호 원문 제외, 파생값만). */
export interface CodefProfileFields {
  name: string | null;
  region: string | null;
  biz_age_months: number | null;
  industries: string[];
  target_type: string | null;
  revenue_krw: number | null;
  founder_age: number | null;
  gender: "M" | "F" | null;
  masked_identity_no: string | null;
  joint_representative: string | null;
  vat_available: boolean;
  confidence: Partial<Record<string, number>>;
}

/** 오케스트레이터 결과 판별 유니온(UI 소비). */
export type CodefFlowResult =
  | { state: "pending"; sessionId: string; guide: string; remainingMs: number }
  | { state: "second_approval_needed"; sessionId: string; guide: string; remainingMs: number }
  | { state: "done"; sessionId: string; fields: CodefProfileFields }
  | { state: "failed"; sessionId?: string; error: string; errorCode?: string }
  | { state: "expired"; sessionId: string };

// ── 세션 requestSnapshot 스키마(민감 로그인 입력 포함, 종결 즉시 NULL) ─────────────
interface CodefRequestSnapshot {
  loginInput: SimpleAuthLoginInput;
  gender: "M" | "F" | null;
  birthDate8: string;
  startDate: string;
  endDate: string;
  pendingProduct: "corporate-registration" | "vat-base";
  corpFacts?: CorporateRegistrationFacts | null;
  /** VAT 가 2차 승인 대기 중인지(SSO 미성립 폴백). */
  vatAwaitingApproval?: boolean;
}

// ── 환경/토큰 ─────────────────────────────────────────────────────────────────

async function loadEnvConfig(): Promise<CodefEnvConfig> {
  if (process.env.NODE_ENV !== "production") {
    const { loadMonorepoEnv } = await import("../loadMonorepoEnv");
    loadMonorepoEnv();
  }
  return readCodefEnvConfig();
}

/** DB 캐시 → 없거나 만료면 발급 후 저장. accessToken 은 절대 로깅하지 않는다. */
async function ensureAccessToken(config: CodefEnvConfig): Promise<string> {
  const cached = await getCachedCodefToken();
  if (cached) return cached.accessToken;
  const token = await requestCodefToken(config);
  await setCachedCodefToken(token);
  return token.accessToken;
}

// ── 공용 헬퍼 ─────────────────────────────────────────────────────────────────

function remainingMs(session: CodefSessionRecord, now: number = Date.now()): number {
  return Math.max(0, session.expiresAt.getTime() - now);
}

function readSnapshot(session: CodefSessionRecord): CodefRequestSnapshot | null {
  if (!session.requestSnapshot) return null;
  return session.requestSnapshot as unknown as CodefRequestSnapshot;
}

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function safeErrorMessage(error: unknown): { message: string; code?: string } {
  if (error instanceof CodefError) {
    // CodefError.message 는 CODEF 상품 레벨 메시지(사용자 PII 없음). code 만 별도 노출.
    return { message: error.message, ...(error.code ? { code: error.code } : {}) };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: "알 수 없는 오류" };
}

function logTx(stage: string, transactionId?: string): void {
  // transactionId 만 로깅(민감정보 금지).
  if (transactionId) console.info(`[codef] ${stage} tx=${transactionId}`);
}

function buildFields(
  result: ReturnType<typeof buildCompanyProfileFromCodef>,
  vatAvailable: boolean,
): CodefProfileFields {
  const p: CompanyProfile = result.profile;
  return {
    name: p.name ?? null,
    region: p.region?.label ?? p.region?.code ?? null,
    biz_age_months: p.biz_age_months ?? null,
    industries: p.industries ?? [],
    target_type: p.target_types?.[0] ?? null,
    revenue_krw: p.revenue_krw ?? null,
    founder_age: p.founder_age ?? null,
    gender: result.facts.gender,
    masked_identity_no: result.facts.masked_identity_no,
    joint_representative: result.facts.joint_representative,
    vat_available: vatAvailable,
    confidence: (p.confidence ?? {}) as Partial<Record<string, number>>,
  };
}

type CodefDimension = "region" | "biz_age" | "industry" | "target_type" | "revenue" | "founder_age";

function codefProfileDimensions(
  profile: CompanyProfile,
): Array<{ dimension: CodefDimension; value: Record<string, unknown>; confidence: number }> {
  const c = profile.confidence ?? {};
  const out: Array<{ dimension: CodefDimension; value: Record<string, unknown>; confidence: number }> = [];
  if (profile.region?.code) {
    const value: Record<string, unknown> = { code: profile.region.code };
    if (profile.region.label) value.label = profile.region.label;
    out.push({ dimension: "region", value, confidence: c.region ?? 0.95 });
  }
  if (profile.biz_age_months !== null && profile.biz_age_months !== undefined) {
    out.push({
      dimension: "biz_age",
      value: { biz_age_months: profile.biz_age_months, months: profile.biz_age_months },
      confidence: c.biz_age ?? 0.95,
    });
  }
  if (profile.industries?.length) {
    out.push({
      dimension: "industry",
      value: { industries: profile.industries, tags: profile.industries },
      confidence: c.industry ?? 0.95,
    });
  }
  if (profile.target_types?.length) {
    out.push({
      dimension: "target_type",
      value: { target_types: profile.target_types, targets: profile.target_types },
      confidence: c.target_type ?? 0.95,
    });
  }
  if (profile.revenue_krw !== null && profile.revenue_krw !== undefined) {
    out.push({
      dimension: "revenue",
      value: { revenue_krw: profile.revenue_krw, amount_krw: profile.revenue_krw },
      confidence: c.revenue ?? 0.95,
    });
  }
  if (profile.founder_age !== null && profile.founder_age !== undefined) {
    out.push({
      dimension: "founder_age",
      value: { founder_age: profile.founder_age, age: profile.founder_age },
      confidence: c.founder_age ?? 0.9,
    });
  }
  return out;
}

// ── start ────────────────────────────────────────────────────────────────────

/**
 * 간편인증 시작 — 토큰 확보 → 사업자등록증명 1차 요청. 통상 CF-03002(2-way) → pending 세션 반환.
 * 드물게 2-way 없이 바로 성공하면 즉시 VAT 로 이어 완료(done)까지 처리한다.
 */
export async function startSimpleAuth(
  bizNo: string,
  input: StartSimpleAuthInput,
): Promise<CodefFlowResult> {
  let config: CodefEnvConfig;
  let accessToken: string;
  try {
    config = await loadEnvConfig();
    accessToken = await ensureAccessToken(config);
  } catch (error) {
    const { message, code } = safeErrorMessage(error);
    return { state: "failed", error: message, ...(code ? { errorCode: code } : {}) };
  }

  const id = buildCodefSessionId(input.userId ?? "dev", bizNo);
  const loginInput: SimpleAuthLoginInput = {
    loginTypeLevel: CODEF_SIMPLE_AUTH_APPS[input.authApp],
    userName: input.name,
    phoneNo: input.phone,
    birthDate8: input.birth8,
    bizNo,
    ...(input.telecom ? { telecom: input.telecom } : {}),
    id,
  };
  const dateRange = defaultVatBaseDateRange();

  let classification;
  try {
    classification = await requestCodefProduct({
      apiBaseUrl: config.apiBaseUrl,
      path: CORPORATE_REGISTRATION_PATH,
      accessToken,
      body: buildCorporateRegistrationRequest(loginInput),
    });
  } catch (error) {
    const { message, code } = safeErrorMessage(error);
    return { state: "failed", error: message, ...(code ? { errorCode: code } : {}) };
  }
  logTx("corp.first", classification.result.transactionId);

  if (classification.status === "two_way_required") {
    const twoWay = extractTwoWayInfo(classification.data);
    if (!twoWay) return { state: "failed", error: "추가인증 정보를 추출하지 못했습니다.", errorCode: "TWO_WAY_PARSE" };
    const snapshot: CodefRequestSnapshot = {
      loginInput,
      gender: input.gender ?? null,
      birthDate8: input.birth8,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      pendingProduct: "corporate-registration",
    };
    const session = await createCodefSession({
      bizNo,
      userId: input.userId ?? null,
      requestSnapshot: asRecord(snapshot),
      twoWayInfo: asRecord(twoWay),
    });
    return { state: "pending", sessionId: session.id, guide: APPROVAL_GUIDE, remainingMs: remainingMs(session) };
  }

  // 드문 즉시 성공(2-way 없이): 사업자등록증명 캐시 후 VAT 로 이어 완료.
  const corpFacts = normalizeCorporateRegistration(classification.data);
  await upsertCodefEnrichmentCache({
    bizNo,
    scope: "corporate-registration",
    canonicalPayload: corpFacts ? asRecord(corpFacts) : null,
    providerResultCode: classification.result.code,
    providerResultMessage: classification.result.message,
  });
  const snapshot: CodefRequestSnapshot = {
    loginInput,
    gender: input.gender ?? null,
    birthDate8: input.birth8,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    pendingProduct: "vat-base",
    corpFacts,
  };
  const session = await createCodefSession({
    bizNo,
    userId: input.userId ?? null,
    requestSnapshot: asRecord(snapshot),
    twoWayInfo: {},
  });
  return completeSimpleAuth(session.id);
}

// ── complete ───────────────────────────────────────────────────────────────

/**
 * 승인 후 완료 — 사업자등록증명 2-way 완료 → 부가세과세표준(양쪽 SSO 경로) → 프로필 확정(done).
 * 미승인이면 pending/second_approval_needed 로 되돌리고(스냅샷 유지), 만료면 expired.
 */
export async function completeSimpleAuth(sessionId: string): Promise<CodefFlowResult> {
  let session = await getCodefSession(sessionId);
  if (!session) return { state: "failed", error: "세션을 찾을 수 없습니다.", errorCode: "SESSION_NOT_FOUND" };
  if (session.state === "expired") return { state: "expired", sessionId };
  if (session.state === "done") {
    // 완료된 세션 재호출: 상세 fields 는 최초 완료 응답에 실렸다.
    return { state: "done", sessionId, fields: emptyDoneFields() };
  }
  if (session.state === "failed") {
    return { state: "failed", sessionId, error: session.errorCode ?? "실패", ...(session.errorCode ? { errorCode: session.errorCode } : {}) };
  }

  // pending_approval → completing(최초 완료 진입). 이미 completing 이면 재개(전이 없음).
  if (session.state === "pending_approval") {
    const moved = await transitionCodefSession({ id: sessionId, from: "pending_approval", to: "completing" });
    session = moved ?? { ...session, state: "completing" };
  }

  const snapshot = readSnapshot(session);
  if (!snapshot) return finalizeFailed(sessionId, "세션 스냅샷이 없습니다.", "SNAPSHOT_MISSING");

  let config: CodefEnvConfig;
  let accessToken: string;
  try {
    config = await loadEnvConfig();
    accessToken = await ensureAccessToken(config);
  } catch (error) {
    const { message, code } = safeErrorMessage(error);
    return finalizeFailed(sessionId, message, code);
  }

  if (snapshot.pendingProduct === "corporate-registration") {
    return completeCorporateThenVat(session, snapshot, config, accessToken);
  }
  return runVat(session, snapshot, config, accessToken, snapshot.vatAwaitingApproval ? "complete" : "first");
}

/** 사업자등록증명 2-way 완료 → 성공 시 VAT 1차로 이어감. */
async function completeCorporateThenVat(
  session: CodefSessionRecord,
  snapshot: CodefRequestSnapshot,
  config: CodefEnvConfig,
  accessToken: string,
): Promise<CodefFlowResult> {
  const corpBody = buildCorporateRegistrationRequest(snapshot.loginInput);
  const twoWay = session.twoWayInfo as unknown as TwoWayInfo;

  let classification;
  try {
    classification = await requestCodefProduct({
      apiBaseUrl: config.apiBaseUrl,
      path: CORPORATE_REGISTRATION_PATH,
      accessToken,
      body: buildTwoWayRequestBody(corpBody, twoWay),
    });
  } catch (error) {
    const { message, code } = safeErrorMessage(error);
    return finalizeFailed(session.id, message, code);
  }
  logTx("corp.complete", classification.result.transactionId);

  if (classification.status === "two_way_required") {
    // 아직 미승인 — 재시도 한도 관리 후 대기 반환(스냅샷 유지).
    const nextRetry = session.retryCount + 1;
    if (nextRetry > MAX_APPROVAL_RETRY) {
      return finalizeFailed(session.id, "승인 재시도 횟수를 초과했습니다.", "RETRY_EXCEEDED");
    }
    await updateCodefSession({ id: session.id, retryCount: nextRetry });
    return { state: "pending", sessionId: session.id, guide: APPROVAL_GUIDE, remainingMs: remainingMs(session) };
  }

  // 사업자등록증명 성공 → 캐시 후 VAT 로 전환.
  const corpFacts = normalizeCorporateRegistration(classification.data);
  await upsertCodefEnrichmentCache({
    bizNo: session.bizNo,
    scope: "corporate-registration",
    canonicalPayload: corpFacts ? asRecord(corpFacts) : null,
    providerResultCode: classification.result.code,
    providerResultMessage: classification.result.message,
  });

  const nextSnapshot: CodefRequestSnapshot = { ...snapshot, pendingProduct: "vat-base", corpFacts };
  const updated = await updateCodefSession({
    id: session.id,
    requestSnapshot: asRecord(nextSnapshot),
    retryCount: 0, // VAT 승인용 재시도 예산 초기화
  });
  const nextSession = updated ?? { ...session, state: "completing", requestSnapshot: asRecord(nextSnapshot), retryCount: 0 };

  if (!CODEF_VAT_SSO_MODE) {
    // 튜닝 훅: SSO 미신뢰 모드면 곧장 2차 승인 유도(현재 기본은 SSO 시도).
    return { state: "second_approval_needed", sessionId: session.id, guide: APPROVAL_GUIDE, remainingMs: remainingMs(session) };
  }
  return runVat(nextSession, nextSnapshot, config, accessToken, "first");
}

/**
 * 부가세과세표준 — SSO 양쪽 경로.
 *  - mode "first": 사업자등록증명 직후 같은 id 로 1차 시도. CF-00000 즉시 성공(SSO 성립) 또는
 *    CF-03002(SSO 미성립 → 2차 승인 유도).
 *  - mode "complete": 2차 승인 후 is2Way 재요청.
 * CF-00003 등 상품 미신청/조회불가(CodefError)는 관용 — VAT unavailable 로 기록하고 사업자등록증명만으로 완성.
 */
async function runVat(
  session: CodefSessionRecord,
  snapshot: CodefRequestSnapshot,
  config: CodefEnvConfig,
  accessToken: string,
  mode: "first" | "complete",
): Promise<CodefFlowResult> {
  const vatBody = buildVatBaseRequest({
    ...snapshot.loginInput,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
  });
  const body =
    mode === "complete"
      ? buildTwoWayRequestBody(vatBody, session.twoWayInfo as unknown as TwoWayInfo)
      : vatBody;

  let classification;
  try {
    classification = await requestCodefProduct({
      apiBaseUrl: config.apiBaseUrl,
      path: VAT_BASE_CERTIFICATE_PATH,
      accessToken,
      body,
    });
  } catch (error) {
    // CF-00003(상품 미신청) 등 VAT 실패는 전체 실패로 처리하지 않는다 — 사업자등록증명 성공분으로 완성.
    const { message, code } = safeErrorMessage(error);
    await upsertCodefEnrichmentCache({
      bizNo: session.bizNo,
      scope: "vat-base",
      canonicalPayload: null,
      providerResultCode: code ?? null,
      providerResultMessage: message,
      lastError: { code: code ?? "VAT_ERROR", message },
    });
    return finalizeDone(session, snapshot, snapshot.corpFacts ?? null, null);
  }
  logTx(`vat.${mode}`, classification.result.transactionId);

  if (classification.status === "two_way_required") {
    // SSO 미성립(또는 아직 미승인) → VAT twoWayInfo 보관하고 2차 승인 유도.
    const vatTwoWay = extractTwoWayInfo(classification.data);
    if (!vatTwoWay) {
      // 2-way 정보 파싱 실패 → VAT 포기, 사업자등록증명만으로 완성.
      await upsertCodefEnrichmentCache({
        bizNo: session.bizNo,
        scope: "vat-base",
        canonicalPayload: null,
        providerResultCode: classification.result.code,
        providerResultMessage: classification.result.message,
        lastError: { code: "VAT_TWO_WAY_PARSE", message: "VAT 추가인증 정보 파싱 실패" },
      });
      return finalizeDone(session, snapshot, snapshot.corpFacts ?? null, null);
    }
    const nextRetry = mode === "complete" ? session.retryCount + 1 : 0;
    if (nextRetry > MAX_APPROVAL_RETRY) {
      // VAT 승인 재시도 초과 → VAT 포기, 사업자등록증명만으로 완성.
      await upsertCodefEnrichmentCache({
        bizNo: session.bizNo,
        scope: "vat-base",
        canonicalPayload: null,
        providerResultCode: classification.result.code,
        providerResultMessage: classification.result.message,
        lastError: { code: "VAT_RETRY_EXCEEDED", message: "VAT 승인 재시도 초과" },
      });
      return finalizeDone(session, snapshot, snapshot.corpFacts ?? null, null);
    }
    const nextSnapshot: CodefRequestSnapshot = { ...snapshot, pendingProduct: "vat-base", vatAwaitingApproval: true };
    await updateCodefSession({
      id: session.id,
      requestSnapshot: asRecord(nextSnapshot),
      twoWayInfo: asRecord(vatTwoWay),
      retryCount: nextRetry,
    });
    return {
      state: "second_approval_needed",
      sessionId: session.id,
      guide: APPROVAL_GUIDE,
      remainingMs: remainingMs(session),
    };
  }

  // VAT 성공(CF-00000).
  const vatFacts = normalizeVatBase(classification.data);
  await upsertCodefEnrichmentCache({
    bizNo: session.bizNo,
    scope: "vat-base",
    canonicalPayload: vatFacts ? asRecord(vatFacts) : null,
    providerResultCode: classification.result.code,
    providerResultMessage: classification.result.message,
  });
  return finalizeDone(session, snapshot, snapshot.corpFacts ?? null, vatFacts);
}

/** 성공분 병합 → 프로필 확정 → companyProfiles best-effort → done 종결(snapshot NULL). */
async function finalizeDone(
  session: CodefSessionRecord,
  snapshot: CodefRequestSnapshot,
  corpFacts: CorporateRegistrationFacts | null,
  vatFacts: VatBaseFacts | null,
): Promise<CodefFlowResult> {
  const result = buildCompanyProfileFromCodef({
    corporateRegistration: corpFacts,
    vatBase: vatFacts,
    birthDate8: snapshot.birthDate8,
    gender: snapshot.gender,
  });

  // company_profiles 는 best-effort(해당 bizNo company 행 없으면 스킵, 예외 무시).
  await upsertCodefCompanyProfiles({
    bizNo: session.bizNo,
    dimensions: codefProfileDimensions(result.profile),
  });

  await transitionCodefSession({ id: session.id, from: "completing", to: "done" });
  const vatAvailable = vatFacts !== null && vatFacts.hasFiling;
  return { state: "done", sessionId: session.id, fields: buildFields(result, vatAvailable) };
}

/** 현재 세션을 failed 로 종결(snapshot NULL). */
async function finalizeFailed(
  sessionId: string,
  message: string,
  code?: string,
): Promise<CodefFlowResult> {
  const session = await getCodefSession(sessionId);
  if (session && session.state !== "done" && session.state !== "failed" && session.state !== "expired") {
    await transitionCodefSession({
      id: sessionId,
      from: session.state,
      to: "failed",
      patch: { errorCode: code ?? null },
    });
  }
  return { state: "failed", sessionId, error: message, ...(code ? { errorCode: code } : {}) };
}

function emptyDoneFields(): CodefProfileFields {
  return {
    name: null,
    region: null,
    biz_age_months: null,
    industries: [],
    target_type: null,
    revenue_krw: null,
    founder_age: null,
    gender: null,
    masked_identity_no: null,
    joint_representative: null,
    vat_available: false,
    confidence: {},
  };
}

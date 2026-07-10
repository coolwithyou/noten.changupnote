/**
 * 크레딧 리포지토리 포트 — 도메인 계층이 의존하는 인터페이스.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 5.2 applyLedgerEntry 단일 진입점 / lotSelection
 *   - 5.3 hold 알고리즘 (P2 에서 사용)
 *   - 4.13 코드 레벨 통제: user 컨텍스트 없는 경로 차단(런타임 예외), 시스템 경로는 별도 함수
 *   - 6.6 ensureWalletWithSignupBonus
 *
 * 구현: apps/web/src/lib/server/repositories/drizzle.ts (트랜잭션), runtime.ts (mock).
 * ServiceRepositories.credits 로 등록(4단계: ports → drizzle → runtime → serviceData).
 *
 * P1 범위: 지갑/원장/지급의 user-컨텍스트 진입점 + 조회 + 시스템 경로(익명 미터링).
 * P2 범위(hold/capture/metering)는 별도 확장으로 추가한다.
 */

import type { LotSelection } from "./ledger.js";
import type { PricingRule, TokenUsage } from "./pricing.js";

// ── 도메인 레코드 (조회 반환용) ─────────────────────────────────────────

export interface CreditWalletRecord {
  id: string;
  userId: string;
  balanceCredits: number;
  status: "active" | "frozen";
  frozenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CreditLotSource = "signup_bonus" | "purchase" | "plan_grant" | "admin_grant" | "promo";
export type CreditLotStatus = "active" | "exhausted" | "expired" | "revoked";

export interface CreditLotRecord {
  id: string;
  walletId: string;
  source: CreditLotSource;
  initialCredits: number;
  remainingCredits: number;
  expiresAt: Date | null;
  status: CreditLotStatus;
  createdAt: Date;
}

export type CreditLedgerEntryType =
  | "signup_bonus_grant"
  | "purchase_grant"
  | "plan_grant"
  | "admin_grant"
  | "promo_grant"
  | "usage_capture"
  | "refund_deduct"
  | "expiry"
  | "admin_deduct"
  | "reversal";

export type CreditActorType = "user" | "admin" | "system";

export interface LotBreakdownLine {
  lotId: string;
  amount: number;
}

export interface CreditLedgerEntryRecord {
  id: string;
  walletId: string;
  entryType: CreditLedgerEntryType;
  amountCredits: number;
  balanceAfter: number;
  lotBreakdown: LotBreakdownLine[];
  idempotencyKey: string;
  chainHash: string;
  actorType: CreditActorType;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

// ── hold 레코드 (5.3, P2) ──────────────────────────────────────────────

export type CreditHoldStatus = "pending" | "captured" | "released" | "expired";

export interface CreditHoldRecord {
  id: string;
  walletId: string;
  usageEventId: string;
  heldCredits: number;
  capturedCredits: number | null;
  status: CreditHoldStatus;
  expiresAt: Date;
  releasedReason: string | null;
  createdAt: Date;
}

/** capture 결과(6.2 흐름·10.5 영수증 토스트에서 사용). */
export interface CaptureHoldResult {
  hold: CreditHoldRecord;
  /** 실제 차감된 크레딧(shortfall 클램프 반영). */
  creditsCharged: number;
  /** 요율 계산상 필요했으나 잔액 부족으로 못 깎은 크레딧. 0 이면 정상. */
  shortfall: number;
  /** capture 시점에 hold TTL 이 이미 지났었는지(captured_late 감사 신호). */
  capturedLate: boolean;
}

// ── applyLedgerEntry 입력 (5.2) ────────────────────────────────────────

export interface ApplyLedgerEntryInput {
  walletId: string;
  entryType: CreditLedgerEntryType;
  /** 양수=지급, 음수=차감. 0 금지. */
  amountCredits: number;
  idempotencyKey: string;
  /**
   * 차감 분개에서만. 기본 consume_order. expiry/refund 는 targetLotIds 필수.
   *
   * reversal 계약(4.3):
   *  - 음수 분개의 reversal(양수 amount): lotSelection 불필요 — 리포지토리가 reversalOfEntryId 로
   *    원분개를 조회해 그 lotBreakdown 의 lot 에 remaining 을 복원한다(대상 lot 이 expired/revoked 면
   *    동일 조건 대체 lot 신규 생성). 호출측은 targetLotIds 를 넘기지 않는다.
   *  - 양수 분개의 reversal(음수 amount): 호출측이 원분개의 lot 들을 `{ targetLotIds }` 로 지정 차감한다
   *    (지정 차감 경로 재사용). consume_order 로 흘리면 엉뚱한 lot 을 잠식한다(레드팀 M1).
   */
  lotSelection?: LotSelection;
  actorType: CreditActorType;
  actorId?: string | null;
  /** admin_grant/admin_deduct/reversal 은 앱 레벨에서 NOT NULL 강제(4.3). */
  reason?: string | null;
  /** 지급 분개에서 생성될 lot 의 속성. */
  grantLot?: {
    source: CreditLotSource;
    expiresAt: Date | null;
    paymentOrderId?: string | null;
    planSubscriptionId?: string | null;
    grantedByAdminId?: string | null;
    note?: string | null;
  };
  usageEventId?: string | null;
  paymentOrderId?: string | null;
  /**
   * entryType=reversal 일 때 필수 — 정정 대상 원분개 id.
   * 리포지토리가 원분개 존재를 검증하고, 음수 분개의 양수 reversal 이면 그 lotBreakdown 으로 lot 을 복원한다.
   * 원분개당 reversal 1회는 reversal_of_entry_id partial unique index 가 강제한다(4.3).
   */
  reversalOfEntryId?: string | null;
  pricingSnapshot?: Record<string, unknown> | null;
}

// ── 시그니처: user-컨텍스트 진입점 ─────────────────────────────────────
// 4.13: 아래 메서드들은 withCunoteDbUser(userId) 경유에서만 호출돼야 한다.
// 리포지토리 구현이 user 컨텍스트 부재를 런타임 예외로 막는다.

export interface CreditRepository {
  /**
   * 6.6 lazy grant: 지갑 없으면 생성 + signup_bonus_grant 분개(key=signup:{userId}, 멱등).
   * 이미 지갑이 있으면 지급 없이 지갑만 반환. 재호출·경쟁 안전.
   */
  ensureWalletWithSignupBonus(userId: string): Promise<CreditWalletRecord>;

  /** 본인 지갑 조회(없으면 null). RLS + user 컨텍스트 가드. */
  getWalletForUser(userId: string): Promise<CreditWalletRecord | null>;

  /** 본인 지갑의 active lot 목록(소진 순서 정렬). */
  listActiveLotsForUser(userId: string): Promise<CreditLotRecord[]>;

  /**
   * 5.2 단일 진입점. user 컨텍스트 트랜잭션 내에서 호출.
   * 멱등(idempotencyKey 충돌 시 기존 분개 반환, no-op 성공).
   */
  applyLedgerEntry(userId: string, input: ApplyLedgerEntryInput): Promise<CreditLedgerEntryRecord>;

  // ── hold 알고리즘 (5.3, P2) ──────────────────────────────────────────
  // 모두 user 컨텍스트 경유. withCreditMetering(6.2) 이 오케스트레이션한다.

  /**
   * 5.3 acquireHold: 지갑 FOR UPDATE → Σpending holds 합산 → available 검사 → INSERT.
   * held = ceil(estimatedCredits × hold_buffer_ratio). available < held → InsufficientCreditsError(402).
   * expiresAt = now + hold_ttl_seconds. wallet frozen → WalletFrozenError(403).
   *
   * excludeBonusLots(13.1): 회사 보너스 소모 상한 초과 시 true — available 계산에서 signup_bonus lot
   * 잔량을 제외하고(유료 잔액만) 402 를 판정한다. capture 도 동일 필터를 쓰도록 hold 에 기록된다.
   */
  acquireHold(
    userId: string,
    input: {
      walletId: string;
      usageEventId: string;
      estimatedCredits: number;
      excludeBonusLots?: boolean;
    },
  ): Promise<CreditHoldRecord>;

  /**
   * 5.3 captureHold: hold 상태에 의존하지 않는다(레드팀 B3).
   * usage:{usageEventId} 멱등 키로 정산 — released/expired 여도 진행. captured 면 no-op.
   * lot 필터는 expires_at > hold.createdAt(만료 유예, 레드팀 M8).
   * shortfall 시 잔액 0 클램프 + usage_events.context_ref.shortfall + creditsCharged=실차감액.
   *
   * excludeBonusLots(13.1): 상한 초과 hold 였으면 소진에서 signup_bonus lot 을 제외한다.
   */
  captureHold(
    userId: string,
    input: {
      holdId: string;
      actualCredits: number;
      pricingSnapshot?: Record<string, unknown> | null;
      excludeBonusLots?: boolean;
    },
  ): Promise<CaptureHoldResult>;

  /**
   * 5.3 releaseHold: status=released(원장 분개 없음). 이미 captured 면 no-op.
   */
  releaseHold(userId: string, input: { holdId: string; reason: string }): Promise<CreditHoldRecord>;

  // ── usage_events 라이프사이클 (6.2, P2) ──────────────────────────────

  /**
   * 6.2 (a) 과금 경로 usage_events INSERT(status=pending). hold·capture 이전.
   * 반환 id 로 hold·capture 를 연결한다.
   */
  createPendingUsageEvent(
    userId: string,
    input: {
      walletId: string;
      companyId: string | null;
      featureCode: string;
      provider: string;
      model: string | null;
      pricingRuleId: string | null;
      requestId: string;
      contextRef?: Record<string, unknown>;
    },
  ): Promise<{ id: string }>;

  /**
   * 6.2 (d-2) 토큰 선기록: report(usage) 수신 즉시 토큰량 UPDATE(capture 전, 프로세스 사망 대비).
   * status 는 건드리지 않는다.
   */
  recordUsageTokens(
    userId: string,
    input: {
      usageEventId: string;
      usage: TokenUsage;
      providerCostUsdMicros?: number | null;
    },
  ): Promise<void>;

  /**
   * 6.2 (d) 실패 경로: usage_events UPDATE status=failed(+errorCode). releaseHold 와 함께 호출.
   */
  markUsageEventFailed(
    userId: string,
    input: { usageEventId: string; errorCode: string },
  ): Promise<void>;

  /**
   * 13.1 회사 스코프 보너스 소모 상한 검사용: 이 companyId 컨텍스트에서 signup_bonus lot 으로
   * 소모된 누적 크레딧을 계산한다(usage_events.companyId + ledger lotBreakdown).
   */
  sumCompanyBonusConsumption(userId: string, companyId: string): Promise<number>;

  // ── 조회 API 지원 (9.1, P2) ──────────────────────────────────────────

  /** 9.1 balance: pending hold 합산(available 계산용). */
  sumPendingHolds(userId: string, walletId: string): Promise<number>;

  /** 9.1 ledger: 분개 목록(커서 페이지네이션, 최신순). */
  listLedgerForUser(
    userId: string,
    input: { walletId: string; limit: number; cursor?: string | null; entryType?: string | null },
  ): Promise<{ entries: LedgerListRow[]; nextCursor: string | null; hasMore: boolean }>;

  /** 9.1 usage: usage_events 목록 + 기간 합계(byFeature). */
  listUsageForUser(
    userId: string,
    input: {
      walletId: string;
      from?: Date | null;
      to?: Date | null;
      featureCode?: string | null;
      limit: number;
      cursor?: string | null;
    },
  ): Promise<{
    events: UsageListRow[];
    summary: { totalCredits: number; byFeature: Array<{ featureCode: string; credits: number; count: number }> };
    nextCursor: string | null;
    hasMore: boolean;
  }>;
}

/** 원장 목록 행(조회용 원시 표현 — DTO 조립은 라우트가 한다). */
export interface LedgerListRow {
  id: string;
  entryType: CreditLedgerEntryType;
  amountCredits: number;
  balanceAfter: number;
  reason: string | null;
  createdAt: Date;
}

/** usage 목록 행(조회용). */
export interface UsageListRow {
  id: string;
  featureCode: string;
  creditsCharged: number;
  status: "pending" | "settled" | "failed" | "free";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  contextRef: Record<string, unknown>;
  createdAt: Date;
}

// ── 시스템 경로(4.13 예외) ─────────────────────────────────────────────
// 웹훅·cron·익명 미터링 등 user 컨텍스트가 없는 신뢰 서버 경로. 명시적으로 분리해 감사 가능하게 한다.

export interface CreditSystemRepository {
  /**
   * 6.5 익명/무과금 미터링: usage_events INSERT (walletId 는 세션 있으면 연결, 없으면 null).
   * 크레딧 잔액에 영향 없음. 시스템 경로임을 이름으로 명시.
   */
  recordFreeUsageEvent(input: {
    walletId: string | null;
    userId: string | null;
    companyId: string | null;
    featureCode: string;
    provider: string | null;
    model?: string | null;
    contextRef?: Record<string, unknown>;
    requestId?: string | null;
  }): Promise<{ id: string }>;

  /** 유효기간 내 요율 후보 조회(resolver 입력). 시스템 신뢰 경로(요율은 RLS 차단 테이블). */
  listEffectivePricingRules(at: Date): Promise<PricingRule[]>;

  /**
   * 4.7 설정 KV 읽기(숫자값). 시스템 신뢰 경로(credit_settings 는 RLS 차단 테이블).
   * 결제·정산 경로는 캐시 무시하고 직독한다(4.7). key 부재 시 fallback 반환.
   */
  readNumericSetting(key: string, fallback: number): Promise<number>;

  /**
   * 4.7 설정 KV 원시 객체 읽기. `readNumericSetting` 은 `.value`(숫자)만 읽으므로
   * 객체값 설정(plan_grant_expiry_cycles = { value, flexValue }, plan_retry_schedule_days = { value: [1,3] })
   * 의 flexValue·배열을 얻으려면 이 메서드로 raw jsonb 를 통째로 읽는다(P4-B).
   * key 부재 시 null.
   */
  readJsonSetting(key: string): Promise<Record<string, unknown> | null>;

  /**
   * 6.2 운영 배치 원가 미터링(무과금, walletId 없음). usage_events INSERT(status=free, creditsCharged=0)
   * + 실측 토큰/원가 기록. 지원서 등 사용자 과금은 이 경로가 아니라 createPendingUsageEvent+capture 를 쓴다.
   *
   * 운영 배치는 지갑·user 컨텍스트가 없으므로 시스템 경로다(4.13). 반환 id 로 후속 토큰 기록.
   */
  recordOpsUsageEvent(input: {
    featureCode: string;
    provider: string;
    model: string | null;
    usage: TokenUsage | null;
    providerCostUsdMicros?: number | null;
    requestId?: string | null;
    contextRef?: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

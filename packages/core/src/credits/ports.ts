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
import type { PricingRule } from "./pricing.js";

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
}

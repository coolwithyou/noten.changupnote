/**
 * 크레딧 도메인 오류.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md 6.4 (API 오류 규약).
 * 이 오류들은 순수 도메인 계층에서 던지고, API 라우트 계층(P2+)에서 HTTP/ActionResult 로 매핑한다.
 * HTTP 매핑은 code 로 하므로 각 오류에 안정적인 code 를 부여한다.
 */

export type CreditErrorCode =
  | "insufficient_credits"
  | "wallet_frozen"
  | "pricing_unavailable"
  | "credit_context_required"
  | "invalid_ledger_entry";

export class CreditError extends Error {
  readonly code: CreditErrorCode;
  readonly meta: Record<string, unknown>;

  constructor(code: CreditErrorCode, message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.name = "CreditError";
    this.code = code;
    this.meta = meta;
  }
}

/** 잔액 부족(hold 실패). 6.4 → HTTP 402. meta 에 { required, available, shortfall }. */
export class InsufficientCreditsError extends CreditError {
  constructor(input: { required: number; available: number }) {
    const shortfall = Math.max(0, input.required - input.available);
    super("insufficient_credits", "크레딧 잔액이 부족합니다.", {
      required: input.required,
      available: input.available,
      shortfall,
    });
    this.name = "InsufficientCreditsError";
  }
}

/** 지갑 동결. 6.4 → HTTP 403. 4.1 frozen 의미론(신규 hold·checkout·지급 차단). */
export class WalletFrozenError extends CreditError {
  constructor(walletId: string, reason?: string | null) {
    super("wallet_frozen", "동결된 지갑입니다.", { walletId, reason: reason ?? null });
    this.name = "WalletFrozenError";
  }
}

/** 요율 미정의. 6.3 "요율 없으면 불가". 6.4 → HTTP 503. */
export class PricingRuleMissingError extends CreditError {
  constructor(input: { featureCode: string; model: string | null }) {
    super("pricing_unavailable", "적용 가능한 요율이 정의되어 있지 않습니다.", {
      featureCode: input.featureCode,
      model: input.model,
    });
    this.name = "PricingRuleMissingError";
  }
}

/**
 * 크레딧 테이블 접근에 user 컨텍스트가 없다.
 * 4.13 코드 레벨 통제(1선 방어) — user 컨텍스트 없는 경로에서 크레딧 테이블 접근 차단.
 * 시스템 경로(웹훅·cron·익명 미터링)는 명시적 별도 함수를 써야 하며 이 오류를 만나면 안 된다.
 */
export class CreditContextRequiredError extends CreditError {
  constructor(operation: string) {
    super(
      "credit_context_required",
      `크레딧 작업 "${operation}"은 user 컨텍스트(withCunoteDbUser) 경유만 허용됩니다.`,
      { operation },
    );
    this.name = "CreditContextRequiredError";
  }
}

/** 잘못된 분개 요청(도메인 불변식 위반). 프로그래밍 오류. */
export class InvalidLedgerEntryError extends CreditError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super("invalid_ledger_entry", message, meta);
    this.name = "InvalidLedgerEntryError";
  }
}

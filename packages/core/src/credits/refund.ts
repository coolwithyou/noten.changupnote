/**
 * 환불 계산 (순수 함수).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 7.4 환불 이원 정책(청약철회 7일 이내 / 임의 환불 7일 이후)
 *   - 16.1 환불 계산 단위 테스트(철회 보너스 선소진 후 원금 보장 / 임의 환불 보너스 회수 /
 *     환불 불가 / 업그레이드 72h 합산 / admin_grant·promo 배제)
 *
 * ★ 규범(레드팀 M1-보안): 환불 대상 lot 은 purchase(및 plan_grant) 만이다.
 *   admin_grant·promo·signup_bonus lot 은 유료가 아니므로 환불 계산에서 명시적으로 배제한다.
 *   (admin_grant 를 유료로 오인한 현금 유출 차단.)
 *
 * ★ 이 모듈은 "얼마를 환불하고 얼마 크레딧을 회수하는지"만 계산한다.
 *   실제 포트원 취소 호출·원장 분개는 실행 경로(admin refunds — 후속)가 한다.
 *   회수 lot 지정은 반드시 targetLotIds 모드(레드팀 M1)로, 이 계산이 반환한 lot 목록을 쓴다.
 */

/** 환불 대상이 될 수 있는 lot source(유료). 이외(signup_bonus/admin_grant/promo)는 배제. */
export type RefundableLotSource = "purchase" | "plan_grant";
export type RefundLotSource = RefundableLotSource | "signup_bonus" | "admin_grant" | "promo";

/** 환불 계산 입력이 되는 lot 스냅샷. */
export interface RefundLotSnapshot {
  lotId: string;
  source: RefundLotSource;
  /** 지급 당시 초기 크레딧(원금+보너스가 각각 별도 lot 이 아닌 경우 initial 로 소진량 판정). */
  initialCredits: number;
  /** 현재 잔여 크레딧. */
  remainingCredits: number;
  /**
   * 이 lot 이 보너스 크레딧으로 지급된 분량(원금과 구분).
   * 충전 상품의 보너스(bonusCredits)는 원금 lot 과 합쳐 하나의 purchase lot 으로 지급되므로,
   * 소진 순서(2.5)상 보너스가 먼저 소모된다는 전제하에 "원금 보장" 계산에 쓴다.
   */
  bonusCredits: number;
}

/** 7.4 환불 정책 구분. */
export type RefundKind = "withdrawal" | "discretionary";

export interface RefundCalcInput {
  /** 결제 시점 스냅샷 환율(원/크레딧). 4.8 krwPerCreditSnapshot. */
  krwPerCredit: number;
  /** 결제 원금(원). 부분 환불의 상한. */
  amountKrw: number;
  /** 이 주문으로 지급된 lot 들(purchase 또는 plan_grant). */
  lots: RefundLotSnapshot[];
  /** 결제 후 경과일(정수 일수). 7 이내면 청약철회, 초과면 임의 환불. */
  daysSincePayment: number;
  /**
   * 업그레이드 72h 합산 판정용(플랜). 직전 72h 내 업그레이드가 있었다면
   * 이전 플랜 lot 의 소모 크레딧을 합산해 "미사용" 판정에 반영한다(레드팀).
   * 충전(topup)에는 해당 없음 — 0.
   */
  priorUpgradeConsumedCredits?: number;
}

export interface RefundCalcResult {
  /** 환불 가능 여부. false 면 사유(reason). */
  refundable: boolean;
  kind: RefundKind;
  /** 실제 환불할 원화 금액. refundable=false 면 0. */
  refundKrw: number;
  /** 회수할 크레딧 수(양수). 원장에는 -recoverCredits 로 분개(refund_deduct). */
  recoverCredits: number;
  /** 회수 대상 lot id(targetLotIds 모드 강제 — 레드팀 M1). */
  targetLotIds: string[];
  /** 환불 불가·부분 계산의 사람이 읽는 사유. */
  reason: string;
}

/** 7일 이내면 청약철회, 초과면 임의 환불. */
export function refundKindOf(daysSincePayment: number): RefundKind {
  return daysSincePayment <= 7 ? "withdrawal" : "discretionary";
}

/** 유료(환불 대상) lot 만 남긴다(레드팀 M1-보안). */
export function filterRefundableLots(lots: RefundLotSnapshot[]): RefundLotSnapshot[] {
  return lots.filter((l) => l.source === "purchase" || l.source === "plan_grant");
}

/**
 * 7.4 환불 계산.
 *
 * 청약철회(7일 이내):
 *   미사용(remaining==initial) → 전액 환불.
 *   부분 사용 → 실소진 크레딧의 원화 가치만 차감하고 잔여 원금 환불.
 *     소진 순서상 보너스가 먼저 소모되므로 "보너스만 쓰고 원금 철회"도 원금은 보장.
 *     환불액 = amountKrw − max(0, 소진량 − bonusCredits) × krwPerCredit  (원금 소진분만 차감)
 *     회수 크레딧 = 남은 잔여(remaining) 전체(환불하는 만큼 지급했던 크레딧을 되돌린다).
 *   업그레이드 72h 합산: priorUpgradeConsumedCredits 를 소진량에 합산해 미사용 판정.
 *
 * 임의 환불(7일 초과):
 *   보너스 크레딧 전액 회수 후 잔여 크레딧 × krwPerCredit 부분 환불.
 *   보너스 회수로 잔액 부족(회수 필요 > 잔여) → 환불 불가(사용자 안내).
 *
 * admin_grant·promo·signup_bonus lot 은 배제(레드팀 M1). 유료 lot 이 없으면 환불 불가.
 */
export function calculateRefund(input: RefundCalcInput): RefundCalcResult {
  const kind = refundKindOf(input.daysSincePayment);
  const paidLots = filterRefundableLots(input.lots);

  if (paidLots.length === 0) {
    return {
      refundable: false,
      kind,
      refundKrw: 0,
      recoverCredits: 0,
      targetLotIds: [],
      reason: "환불 가능한 유료 크레딧이 없습니다.",
    };
  }

  const totalInitial = paidLots.reduce((s, l) => s + l.initialCredits, 0);
  const totalRemaining = paidLots.reduce((s, l) => s + l.remainingCredits, 0);
  const totalBonus = paidLots.reduce((s, l) => s + l.bonusCredits, 0);
  const targetLotIds = paidLots.map((l) => l.lotId);

  if (kind === "withdrawal") {
    // 소진량 = 지급 - 잔여. 업그레이드 72h 내 이전 lot 소모분을 합산(미사용 위장 차단).
    const consumed = totalInitial - totalRemaining + Math.max(0, input.priorUpgradeConsumedCredits ?? 0);
    // 원금 소진분(보너스 선소진 전제 — 보너스를 초과한 소진만 원금에서 나갔다고 본다).
    const principalConsumed = Math.max(0, consumed - totalBonus);
    const refundKrw = Math.max(0, input.amountKrw - principalConsumed * input.krwPerCredit);
    // 회수 크레딧 = 현재 잔여 전체(환불과 함께 지급 크레딧을 되돌린다).
    const recoverCredits = totalRemaining;
    return {
      refundable: true,
      kind,
      refundKrw,
      recoverCredits,
      targetLotIds,
      reason:
        principalConsumed > 0
          ? `청약철회: 원금 소진 ${principalConsumed} 크레딧 차감 후 환불`
          : "청약철회: 미사용 원금 전액 환불",
    };
  }

  // 임의 환불: 보너스 전액 회수 후 잔여 크레딧을 부분 환불.
  // 보너스 회수 필요량이 현재 잔여를 초과하면(이미 원금까지 소진) 환불 불가.
  if (totalBonus > totalRemaining) {
    return {
      refundable: false,
      kind,
      refundKrw: 0,
      recoverCredits: 0,
      targetLotIds: [],
      reason: "보너스 회수 후 잔액이 부족해 환불할 수 없습니다.",
    };
  }
  // 보너스 회수 후 남는 유료 잔여 = 환불 대상 크레딧.
  const refundableCredits = totalRemaining - totalBonus;
  if (refundableCredits <= 0) {
    return {
      refundable: false,
      kind,
      refundKrw: 0,
      recoverCredits: 0,
      targetLotIds: [],
      reason: "환불 가능한 잔여 크레딧이 없습니다.",
    };
  }
  const refundKrw = Math.min(input.amountKrw, refundableCredits * input.krwPerCredit);
  // 회수 크레딧 = 보너스(전액) + 환불되는 잔여 원금.
  const recoverCredits = totalBonus + refundableCredits; // == totalRemaining
  return {
    refundable: true,
    kind,
    refundKrw,
    recoverCredits,
    targetLotIds,
    reason: `임의 환불: 보너스 ${totalBonus} 회수 후 잔여 ${refundableCredits} 크레딧 환불`,
  };
}

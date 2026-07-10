/**
 * 대사(reconciliation) 검증 코어 — 순수 함수.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 14.1 일일 대사 5 scope (ledger_wallet / lot_ledger / holds / portone_orders / admin_activity)
 *   - 14.2 verify 스크립트와 동일 검증 코어 공유(chainHash 체인 재계산)
 *   - 5.1 불변식 I1~I10
 *
 * ★ 규범: chainHash 체인 재계산 로직은 여기 단일 정의를 verify 스크립트(14.2)와 대사 cron(14.1)이
 *   함께 쓴다. 두 곳이 검증 코어를 각자 재구현하면 한쪽만 고쳐지는 사고가 난다.
 *   이 모듈은 DB·LLM 미의존 — 리포지토리가 읽어 넘긴 분개 행 배열을 받아 재계산만 한다.
 */

import { computeChainHash, genesisHash } from "./ledger.js";

/** 한 분개의 재계산 입력(리포지토리가 createdAt·id 순으로 정렬해 넘긴다). */
export interface LedgerEntryForChain {
  id: string;
  entryType: string;
  amountCredits: number;
  balanceAfter: number;
  idempotencyKey: string;
  chainHash: string;
  createdAt: Date;
}

/** 지갑 하나의 체인 재계산 결과. I9(누적 잔액)·I10(chainHash 변조) 위반을 함께 반환. */
export interface WalletChainResult {
  walletId: string;
  entryCount: number;
  /** I9: balance_after 가 분개 누적과 어긋난 분개들. */
  balanceMismatches: Array<{ entryId: string; running: number; balanceAfter: number }>;
  /** I10: 재계산 chainHash 가 저장값과 다른 분개들(삭제·수정·중간 삽입 변조 신호). */
  chainMismatches: Array<{ entryId: string }>;
  /** 마지막 분개 이후 running 총합(지갑 balance 대조용 = Σledger, I1). */
  ledgerSum: number;
}

/**
 * 지갑 하나의 분개 체인을 genesis 부터 재계산한다(I9 + I10).
 *
 * @param walletId 지갑 id(genesis 해시 시드).
 * @param entries  createdAt ASC, id ASC 로 정렬된 이 지갑의 전체 분개.
 * @returns 누적 잔액·chainHash 위반 목록 + Σledger.
 *
 * 검출 원리(14.1 scope 1):
 *  - 중간 분개 1건이라도 수정되면 그 분개의 chainHash 가 어긋나고, 이후 모든 분개의 prev 가 달라져
 *    연쇄적으로 mismatch 가 뜬다.
 *  - 중간 분개 1건이 삭제되면 다음 분개의 prev 가 삭제된 분개의 hash 가 아니게 되어 mismatch.
 *  - 중간 분개가 삽입되면 삽입분의 재계산 hash 가 저장된 위조 hash 와 달라 mismatch.
 */
export function recomputeWalletChain(
  walletId: string,
  entries: readonly LedgerEntryForChain[],
): WalletChainResult {
  const balanceMismatches: WalletChainResult["balanceMismatches"] = [];
  const chainMismatches: WalletChainResult["chainMismatches"] = [];
  let running = 0;
  let prevChain = genesisHash(walletId);

  for (const e of entries) {
    running += e.amountCredits;
    if (running !== e.balanceAfter) {
      balanceMismatches.push({ entryId: e.id, running, balanceAfter: e.balanceAfter });
    }
    const expected = computeChainHash({
      prevChainHash: prevChain,
      id: e.id,
      walletId,
      entryType: e.entryType,
      amountCredits: e.amountCredits,
      balanceAfter: e.balanceAfter,
      idempotencyKey: e.idempotencyKey,
      createdAt: e.createdAt,
    });
    if (expected !== e.chainHash) {
      chainMismatches.push({ entryId: e.id });
    }
    // 다음 분개의 prev 는 "저장된" chainHash 를 쓴다(재계산값이 아니라). 그래야 변조된 분개 1건이
    // 자기 자신만 mismatch 로 뜨고, 뒤 분개는 저장 체인을 기준으로 독립 검증된다.
    prevChain = e.chainHash;
  }

  return {
    walletId,
    entryCount: entries.length,
    balanceMismatches,
    chainMismatches,
    ledgerSum: running,
  };
}

// ── 대사 scope 식별자 (14.1) ──────────────────────────────────────────
// credit_reconciliation_runs.scope 에 기록되는 값. 자유 텍스트 컬럼이지만 여기서 단일 정의한다.
export const RECONCILE_SCOPES = [
  "ledger_wallet", // 1: I1 + chainHash 체인 재계산(I9/I10)
  "lot_ledger", // 2: I2, I5
  "holds", // 3: hold TTL 누락, captured-미정산, released 인데 선기록 토큰 있는 미정산(B3 안전망)
  "portone_orders", // 4: 최근 48h 주문 ↔ 포트원 대조. 고아 결제 최우선 경보
  "admin_activity", // 5: admin_grant 발행 총량·capture_after_expiry 빈도
] as const;

export type ReconcileScope = (typeof RECONCILE_SCOPES)[number];

/** 대사 1회 실행 결과 상태(credit_reconciliation_runs.status). */
export type ReconcileStatus = "ok" | "mismatch" | "error";

/** scope 하나의 실행 결과(cron/내부 엔드포인트가 credit_reconciliation_runs 에 기록). */
export interface ReconcileScopeResult {
  scope: ReconcileScope;
  status: ReconcileStatus;
  summary: Record<string, unknown>;
}

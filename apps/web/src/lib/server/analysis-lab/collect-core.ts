export type AuditCollectAction = "write" | "recover_receipt" | "stale" | "skip_reconcile";

/**
 * 감사 파일 수거 순서의 단일 원천.
 * 이미 판정이 파일에 있으면 dispatch SHA가 달라도 "파일 성공→DB 실패" 잔재로 복구하고,
 * 그렇지 않은 SHA 변경은 병행 편집으로 보고 절대 덮어쓰지 않는다.
 */
export function decideAuditCollectAction(input: {
  expectedSha256: string;
  currentSha256: string;
  decisionsAlreadyApplied: boolean;
  reconcileOnly: boolean;
}): AuditCollectAction {
  if (input.decisionsAlreadyApplied) return "recover_receipt";
  if (input.currentSha256 !== input.expectedSha256) return "stale";
  if (input.reconcileOnly) return "skip_reconcile";
  return "write";
}

export function receiptShaMatches(
  expectedPostSha256: string,
  actualFileSha256: string | null,
): boolean {
  return actualFileSha256 !== null && expectedPostSha256 === actualFileSha256;
}

/** 부분 수거 뒤 다음 CAS는 dispatch 원본이 아니라 가장 최근 성공 receipt의 post SHA를 잇는다. */
export function latestAuditReceiptSha(
  dispatchSha256: string,
  receipts: Array<{ collectedAt: Date | null; postSha256: unknown }>,
): string {
  return receipts
    .filter((receipt): receipt is { collectedAt: Date; postSha256: string } =>
      receipt.collectedAt !== null && typeof receipt.postSha256 === "string")
    .sort((left, right) => left.collectedAt.getTime() - right.collectedAt.getTime())
    .at(-1)?.postSha256 ?? dispatchSha256;
}

/**
 * 비중복은 decided/resolved 즉시 수거하고, 중복 표본은 양측이 같은 판정으로 decided가
 * 됐거나 3심 resolved가 된 뒤에만 양쪽 row를 함께 수거한다.
 */
export function selectCollectableDispatchRowIds(rows: Array<{
  id: string;
  overlapGroup: string | null;
  status: string;
  collectedAt: Date | null;
}>): Set<string> {
  const collectable = new Set(
    rows
      .filter((row) =>
        !row.overlapGroup
        && row.collectedAt === null
        && (row.status === "decided" || row.status === "resolved"))
      .map((row) => row.id),
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.overlapGroup) continue;
    const group = groups.get(row.overlapGroup) ?? [];
    group.push(row);
    groups.set(row.overlapGroup, group);
  }
  for (const group of groups.values()) {
    if (
      group.length < 2
      || !group.every((row) => ["decided", "resolved", "collected"].includes(row.status))
    ) continue;
    for (const row of group) {
      if (
        row.collectedAt === null
        && (row.status === "decided" || row.status === "resolved")
      ) collectable.add(row.id);
    }
  }
  return collectable;
}

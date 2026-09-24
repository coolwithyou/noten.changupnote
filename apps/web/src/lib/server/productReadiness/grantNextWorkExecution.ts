import type { GrantSourceChangeImpact } from "../ingestion/grantSourceChangeImpact";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import {
  classifyGrantReadiness,
  type GrantReadiness,
  type GrantReadinessInput,
} from "./grantReadiness";
import {
  planGrantNextWork,
  type GrantNextWork,
  type GrantNextWorkAction,
} from "./grantNextWork";

export const GRANT_NEXT_WORK_SNAPSHOT_SCHEMA = "grant-next-work-snapshot-v1" as const;
export const GRANT_NEXT_WORK_EXECUTION_SCHEMA = "grant-next-work-execution-v1" as const;

export interface GrantNextWorkSnapshot {
  readonly schema: typeof GRANT_NEXT_WORK_SNAPSHOT_SCHEMA;
  readonly grantId: string;
  /** adapter가 source/question stable key를 exact evidence hash와 같은 입력에서 검증한다. */
  readonly readinessInput: GrantReadinessInput;
  readonly sourceChangeImpact: GrantSourceChangeImpact | null;
  readonly evidenceSha256: string;
  readonly readiness: GrantReadiness;
  readonly nextWork: GrantNextWork;
}

export interface GrantNextWorkAdapterReceipt {
  readonly action: GrantNextWorkAction;
  readonly receiptSha256: string;
  readonly modelCalls: number;
  readonly externalWrites: number;
}

export interface GrantNextWorkAdapter {
  readonly action: GrantNextWorkAction;
  execute(input: {
    readonly grantId: string;
    readonly expectedEvidenceSha256: string;
    readonly snapshot: GrantNextWorkSnapshot;
  }): Promise<GrantNextWorkAdapterReceipt>;
}

export interface GrantNextWorkExecutionResult {
  readonly schema: typeof GRANT_NEXT_WORK_EXECUTION_SCHEMA;
  readonly grantId: string;
  readonly action: GrantNextWorkAction;
  readonly status: "already_complete" | "blocked" | "stalled" | "partial" | "regressed" | "completed";
  readonly beforeEvidenceSha256: string;
  readonly afterEvidenceSha256: string | null;
  readonly nextAction: GrantNextWorkAction;
  readonly reason: string;
  readonly adapterReceiptSha256: string | null;
  readonly modelCalls: number;
  readonly externalWrites: number;
}

/** 현재 evidence 전체를 봉인해 분류 결과와 실행 입력이 서로 다른 시점을 보지 않게 한다. */
export function createGrantNextWorkSnapshot(input: {
  readonly grantId: string;
  readonly readinessInput: GrantReadinessInput;
  readonly sourceChangeImpact?: GrantSourceChangeImpact | null;
}): GrantNextWorkSnapshot {
  const grantId = exactUuid(input.grantId);
  if (input.readinessInput.grantId && input.readinessInput.grantId !== grantId) {
    throw new Error("grant_next_work_grant_mismatch");
  }
  if (
    input.sourceChangeImpact
    && input.sourceChangeImpact.currentRawSha256 !== input.readinessInput.source.rawSha256
  ) {
    throw new Error("grant_next_work_source_impact_drift");
  }
  const readiness = classifyGrantReadiness(input.readinessInput);
  const nextWork = planGrantNextWork(readiness, input.sourceChangeImpact ?? null);
  const evidenceSha256 = sha256Canonical({
    grantId,
    readinessInput: input.readinessInput,
    sourceChangeImpact: input.sourceChangeImpact ?? null,
    readiness,
    nextWork,
  });
  return Object.freeze({
    schema: GRANT_NEXT_WORK_SNAPSHOT_SCHEMA,
    grantId,
    readinessInput: input.readinessInput,
    sourceChangeImpact: input.sourceChangeImpact ?? null,
    evidenceSha256,
    readiness,
    nextWork,
  });
}

/**
 * 처리 직전 exact snapshot을 다시 읽고, 명시적으로 등록된 adapter만 한 번 호출한 뒤 readiness를
 * 다시 읽는다. 분류상 모델 불필요 작업이 모델을 호출했다고 주장하면 결과를 채택하지 않는다.
 */
export async function executeGrantNextWork(input: {
  readonly grantId: string;
  readonly expectedEvidenceSha256: string;
  readonly loadSnapshot: (grantId: string) => Promise<GrantNextWorkSnapshot>;
  readonly adapters: ReadonlyMap<GrantNextWorkAction, GrantNextWorkAdapter>;
  /** 검증된 기존 분석 자산을 승인 release로 발행할 때만 사용한다. adapter는 모델 호출 0을 증명해야 한다. */
  readonly approvedAnalysisReuse?: boolean;
}): Promise<GrantNextWorkExecutionResult> {
  const grantId = exactUuid(input.grantId);
  exactSha256(input.expectedEvidenceSha256, "expected evidence");
  const before = await input.loadSnapshot(grantId);
  assertSnapshot(before, grantId);
  if (before.evidenceSha256 !== input.expectedEvidenceSha256) {
    throw new Error("grant_next_work_snapshot_drift");
  }
  const action = before.nextWork.action;
  if (action === "reuse_ready") {
    return result({
      before,
      status: "already_complete",
      afterEvidenceSha256: before.evidenceSha256,
      nextAction: action,
      reason: "readiness_already_complete",
    });
  }
  if (before.nextWork.requiresModelRun && !(
    input.approvedAnalysisReuse && action === "condition_analysis"
    && input.adapters.get(action)?.action === "condition_analysis"
  )) {
    return result({
      before,
      status: "blocked",
      afterEvidenceSha256: null,
      nextAction: action,
      reason: "model_run_requires_separate_authority",
    });
  }
  const adapter = input.adapters.get(action);
  if (!adapter) {
    return result({
      before,
      status: "blocked",
      afterEvidenceSha256: null,
      nextAction: action,
      reason: "next_work_adapter_unavailable",
    });
  }
  if (adapter.action !== action) throw new Error("grant_next_work_adapter_action_mismatch");
  const receipt = await adapter.execute({
    grantId,
    expectedEvidenceSha256: before.evidenceSha256,
    snapshot: before,
  });
  assertReceipt(receipt, action);
  if (receipt.modelCalls !== 0) throw new Error("grant_next_work_unexpected_model_call");

  const after = await input.loadSnapshot(grantId);
  assertSnapshot(after, grantId);
  if (categoryRank(after.readiness.category) > categoryRank(before.readiness.category)) {
    return result({
      before,
      status: "regressed",
      afterEvidenceSha256: after.evidenceSha256,
      nextAction: after.nextWork.action,
      reason: "readiness_regressed",
      receipt,
    });
  }
  if (after.evidenceSha256 === before.evidenceSha256) {
    return result({
      before,
      status: "stalled",
      afterEvidenceSha256: after.evidenceSha256,
      nextAction: after.nextWork.action,
      reason: "readiness_did_not_advance",
      receipt,
    });
  }
  if (after.nextWork.action === action) {
    return result({
      before,
      status: "partial",
      afterEvidenceSha256: after.evidenceSha256,
      nextAction: after.nextWork.action,
      reason: "readiness_advanced_with_same_action",
      receipt,
    });
  }
  return result({
    before,
    status: "completed",
    afterEvidenceSha256: after.evidenceSha256,
    nextAction: after.nextWork.action,
    reason: "readiness_advanced",
    receipt,
  });
}

function result(input: {
  before: GrantNextWorkSnapshot;
  status: GrantNextWorkExecutionResult["status"];
  afterEvidenceSha256: string | null;
  nextAction: GrantNextWorkAction;
  reason: string;
  receipt?: GrantNextWorkAdapterReceipt;
}): GrantNextWorkExecutionResult {
  return Object.freeze({
    schema: GRANT_NEXT_WORK_EXECUTION_SCHEMA,
    grantId: input.before.grantId,
    action: input.before.nextWork.action,
    status: input.status,
    beforeEvidenceSha256: input.before.evidenceSha256,
    afterEvidenceSha256: input.afterEvidenceSha256,
    nextAction: input.nextAction,
    reason: input.reason,
    adapterReceiptSha256: input.receipt?.receiptSha256 ?? null,
    modelCalls: input.receipt?.modelCalls ?? 0,
    externalWrites: input.receipt?.externalWrites ?? 0,
  });
}

function assertSnapshot(snapshot: GrantNextWorkSnapshot, grantId: string): void {
  if (snapshot.schema !== GRANT_NEXT_WORK_SNAPSHOT_SCHEMA || snapshot.grantId !== grantId) {
    throw new Error("grant_next_work_snapshot_invalid");
  }
  exactSha256(snapshot.evidenceSha256, "snapshot evidence");
  if (snapshot.readinessInput.grantId && snapshot.readinessInput.grantId !== grantId) {
    throw new Error("grant_next_work_snapshot_input_grant_mismatch");
  }
  if (
    snapshot.sourceChangeImpact
    && snapshot.sourceChangeImpact.currentRawSha256 !== snapshot.readinessInput.source.rawSha256
  ) {
    throw new Error("grant_next_work_snapshot_source_impact_drift");
  }
  const readiness = classifyGrantReadiness(snapshot.readinessInput);
  const nextWork = planGrantNextWork(readiness, snapshot.sourceChangeImpact);
  const expectedEvidenceSha256 = sha256Canonical({
    grantId,
    readinessInput: snapshot.readinessInput,
    sourceChangeImpact: snapshot.sourceChangeImpact,
    readiness,
    nextWork,
  });
  if (
    snapshot.evidenceSha256 !== expectedEvidenceSha256
    || sha256Canonical(snapshot.readiness) !== sha256Canonical(readiness)
    || sha256Canonical(snapshot.nextWork) !== sha256Canonical(nextWork)
  ) {
    throw new Error("grant_next_work_snapshot_integrity_invalid");
  }
}

function assertReceipt(receipt: GrantNextWorkAdapterReceipt, action: GrantNextWorkAction): void {
  if (receipt.action !== action) throw new Error("grant_next_work_receipt_action_mismatch");
  exactSha256(receipt.receiptSha256, "adapter receipt");
  if (!Number.isSafeInteger(receipt.modelCalls) || receipt.modelCalls < 0) {
    throw new Error("grant_next_work_receipt_model_calls_invalid");
  }
  if (!Number.isSafeInteger(receipt.externalWrites) || receipt.externalWrites < 0) {
    throw new Error("grant_next_work_receipt_external_writes_invalid");
  }
}

function exactUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("grant_next_work_grant_invalid");
  }
  return value.toLowerCase();
}

function exactSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`grant_next_work_${label.replaceAll(" ", "_")}_invalid`);
}

function categoryRank(category: GrantReadiness["category"]): number {
  return { A: 0, B: 1, C: 2, D: 3 }[category];
}

import { AsyncLocalStorage } from "node:async_hooks";

export interface AnalysisLaunchTargetBinding {
  readonly grantId: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly reviewRepair?: {
    readonly sourceRunId: string;
    readonly reviewModel: string;
    readonly blockingCount: number;
    readonly taskInstruction: string;
  };
}

export interface AnalysisLaunchBatchExecutionBinding {
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly model: string;
  readonly transport: "claude-cli";
  readonly promptVersion: string;
  readonly withApplicationRoundtrip: boolean;
  readonly roundtripModel: string | null;
  readonly targets: ReadonlyMap<string, AnalysisLaunchTargetBinding>;
}

const launchBatchExecution = new AsyncLocalStorage<AnalysisLaunchBatchExecutionBinding>();

/** 검증된 launch coordinator만 여는 cohort 단위 capability다. */
export function withAnalysisLaunchBatchExecution<T>(
  binding: AnalysisLaunchBatchExecutionBinding,
  run: () => Promise<T>,
): Promise<T> {
  return launchBatchExecution.run(normalizeBinding(binding), run);
}

/** transport와 target admission이 읽는 read-only capability 조회다. */
export function currentAnalysisLaunchBatchExecutionBinding():
  AnalysisLaunchBatchExecutionBinding | null {
  return launchBatchExecution.getStore() ?? null;
}

function normalizeBinding(
  binding: AnalysisLaunchBatchExecutionBinding,
): AnalysisLaunchBatchExecutionBinding {
  assertSha256(binding.grantSha256, "grantSha256");
  assertSha256(binding.manifestSha256, "manifestSha256");
  if (binding.model.trim() === "" || binding.promptVersion.trim() === "") {
    throw new Error("launch batch execution model/prompt binding이 비어 있습니다.");
  }
  if (binding.transport !== "claude-cli") {
    throw new Error("launch batch execution은 claude-cli transport만 허용합니다.");
  }
  if (
    binding.withApplicationRoundtrip
      ? !binding.roundtripModel?.trim()
      : binding.roundtripModel !== null
  ) {
    throw new Error("launch batch 필드 분석/model binding이 일치하지 않습니다.");
  }
  if (binding.targets.size === 0) {
    throw new Error("launch batch target은 한 건 이상이어야 합니다.");
  }
  const targets = new Map<string, AnalysisLaunchTargetBinding>();
  for (const [grantId, target] of binding.targets) {
    if (grantId !== target.grantId || grantId.trim() === "" || targets.has(grantId)) {
      throw new Error(`launch batch target binding이 잘못됐습니다: ${grantId}`);
    }
    assertSha256(target.inputSha256, `${grantId}.inputSha256`);
    assertSha256(
      target.attachmentManifestSha256,
      `${grantId}.attachmentManifestSha256`,
    );
    const reviewRepair = target.reviewRepair;
    if (
      reviewRepair
      && (
        reviewRepair.sourceRunId.trim() === ""
        || reviewRepair.reviewModel.trim() === ""
        || !Number.isSafeInteger(reviewRepair.blockingCount)
        || reviewRepair.blockingCount < 1
        || reviewRepair.taskInstruction.trim() === ""
      )
    ) {
      throw new Error(`launch batch ${grantId}.reviewRepair binding이 잘못됐습니다.`);
    }
    targets.set(grantId, Object.freeze({
      grantId,
      inputSha256: target.inputSha256,
      attachmentManifestSha256: target.attachmentManifestSha256,
      ...(reviewRepair ? { reviewRepair: Object.freeze({ ...reviewRepair }) } : {}),
    }));
  }
  return Object.freeze({ ...binding, targets });
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`launch batch ${field}는 SHA-256이어야 합니다.`);
  }
}

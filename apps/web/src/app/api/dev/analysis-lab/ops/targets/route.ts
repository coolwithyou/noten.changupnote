import { NextResponse } from "next/server";
import type { LabAutomaticTargetSelectionRequest } from "@/features/dev/analysis-lab/contract";
import { getLabBatchJobSnapshot } from "@/lib/server/analysis-lab/batch-job";
import {
  resolveLabLlmBinding,
  resolveLabTransport,
} from "@/lib/server/analysis-lab/claude-cli-transport";
import {
  AUTOMATIC_TARGET_SELECTION_MAX_COUNT,
  AutomaticTargetSelectionConflictError,
  selectAutomaticAnalysisTargets,
} from "@/lib/server/analysis-lab/target-selection";
import { getCunoteDb } from "@/lib/server/db/client";
import {
  DeepAnalysisRuntimeControlError,
  assertLocalSubscriptionAnalysisAllowed,
  localAnalysisOwnerFromRequest,
  renewLocalSubscriptionLease,
} from "@/lib/server/deep-analysis/runtimeControl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let selectionInFlight = false;

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export function parseAutomaticTargetSelectionRequest(
  body: unknown,
): LabAutomaticTargetSelectionRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "본문이 JSON 객체가 아닙니다.";
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.count !== "number"
    || !Number.isInteger(record.count)
    || record.count < 1
    || record.count > AUTOMATIC_TARGET_SELECTION_MAX_COUNT
  ) {
    return `count는 1~${AUTOMATIC_TARGET_SELECTION_MAX_COUNT} 정수여야 합니다.`;
  }
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.trim() === "")) {
    return "model은 비어 있지 않은 문자열이어야 합니다.";
  }
  return {
    count: record.count,
    ...(typeof record.model === "string" ? { model: record.model.trim() } : {}),
  };
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return notFound();
  const parsed = parseAutomaticTargetSelectionRequest(await request.json().catch(() => null));
  if (typeof parsed === "string") {
    return NextResponse.json({ error: "invalid_request", message: parsed }, { status: 400 });
  }
  if (resolveLabTransport() !== "claude-cli") {
    return NextResponse.json(
      {
        error: "subscription_transport_required",
        message: "자동 선정은 ANALYSIS_LAB_TRANSPORT=claude-cli인 로컬 환경에서만 실행합니다.",
      },
      { status: 409 },
    );
  }
  if (getLabBatchJobSnapshot().state === "running") {
    return NextResponse.json(
      { error: "batch_running", message: "분석 배치가 끝난 뒤 새 분석 대상을 선정해 주세요." },
      { status: 409 },
    );
  }
  if (selectionInFlight) {
    return NextResponse.json(
      { error: "selection_running", message: "이미 분석 대상을 자동 선정하고 있습니다." },
      { status: 409 },
    );
  }

  selectionInFlight = true;
  try {
    const ownerId = localAnalysisOwnerFromRequest(request);
    const db = getCunoteDb();
    await assertLocalSubscriptionAnalysisAllowed({ db, ownerId });
    await renewLocalSubscriptionLease({ db, ownerId: ownerId ?? "" });
    const binding = await resolveLabLlmBinding();
    if (binding.transport !== "claude-cli" || !binding.fetchImpl) {
      throw new Error("Claude 구독 transport 바인딩을 만들지 못했습니다.");
    }
    const result = await selectAutomaticAnalysisTargets({
      count: parsed.count,
      transport: binding.transport,
      apiKey: binding.apiKey,
      fetchImpl: binding.fetchImpl,
      ...(parsed.model ? { model: parsed.model } : {}),
    });
    await renewLocalSubscriptionLease({ db, ownerId: ownerId ?? "" });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof DeepAnalysisRuntimeControlError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof AutomaticTargetSelectionConflictError) {
      return NextResponse.json(
        { error: "pending_targets_exist", message: error.message },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: "automatic_target_selection_failed",
        message: error instanceof Error ? error.message : "분석 대상 자동 선정에 실패했습니다.",
      },
      { status: 500 },
    );
  } finally {
    selectionInFlight = false;
  }
}

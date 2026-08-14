import { NextResponse } from "next/server";
import { getCunoteDb } from "@/lib/server/db/client";
import { resolveLabTransport } from "@/lib/server/analysis-lab/claude-cli-transport";
import {
  AnalysisLabExecutionPausedError,
  assertAnalysisLabLiveExecutionAdmitted,
} from "@/lib/server/analysis-lab/analysis-execution-admission";
import {
  DeepAnalysisRuntimeControlError,
  acquireLocalSubscriptionLease,
  getDeepAnalysisRuntimeControl,
  releaseLocalSubscriptionLease,
  renewLocalSubscriptionLease,
  runtimeControlView,
} from "@/lib/server/deep-analysis/runtimeControl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET() {
  if (process.env.NODE_ENV === "production") return notFound();
  try {
    return NextResponse.json(runtimeControlView(await getDeepAnalysisRuntimeControl(getCunoteDb())));
  } catch (error) {
    return controlError(error);
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return notFound();
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    ownerId?: unknown;
  } | null;
  const action = body?.action;
  const ownerId = typeof body?.ownerId === "string" ? body.ownerId : "";
  if (action !== "acquire" && action !== "renew" && action !== "release") {
    return NextResponse.json(
      { error: "invalid_action", message: "action은 acquire, renew 또는 release여야 합니다." },
      { status: 400 },
    );
  }
  if (action !== "release" && resolveLabTransport() !== "claude-cli") {
    return NextResponse.json(
      {
        error: "subscription_transport_required",
        message: "ANALYSIS_LAB_TRANSPORT=claude-cli로 dev 서버를 시작한 뒤 권한을 획득하세요.",
      },
      { status: 409 },
    );
  }
  try {
    if (action !== "release") assertAnalysisLabLiveExecutionAdmitted();
    const db = getCunoteDb();
    const control = action === "acquire"
      ? await acquireLocalSubscriptionLease({
          db,
          ownerId,
          changedBy: `local-analysis:${ownerId.slice(0, 8)}`,
        })
      : action === "renew"
        ? await renewLocalSubscriptionLease({ db, ownerId })
        : await releaseLocalSubscriptionLease({
            db,
            ownerId,
            changedBy: `local-analysis:${ownerId.slice(0, 8)}`,
          });
    return NextResponse.json(runtimeControlView(control));
  } catch (error) {
    return controlError(error);
  }
}

function controlError(error: unknown): Response {
  if (error instanceof AnalysisLabExecutionPausedError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: 423 },
    );
  }
  if (error instanceof DeepAnalysisRuntimeControlError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: "runtime_control_failed",
      message: error instanceof Error ? error.message : "실행 모드 처리에 실패했습니다.",
    },
    { status: 500 },
  );
}

// 공모 딥분석 실험실 — 웹 배치 잡 (dev 전용: production 이면 404). 동시 1잡 싱글턴.
// POST   /api/dev/analysis-lab/ops/batch  본문 LabBatchStartRequest → 202 + LabBatchJobSnapshot
//        (transport/model 미지정 시 서버 env 로 확정 — 실행 중이면 409 + 현재 스냅샷)
// GET    /api/dev/analysis-lab/ops/batch  → LabBatchJobSnapshot (2~5s 폴링 — idle 이면 직전
//        잡 잔상 또는 초기 상태, dev 서버 재시작 잔상은 aborted 강등 표시)
// DELETE /api/dev/analysis-lab/ops/batch  → abort 후 스냅샷 (신규 착수만 중단 — 진행분은
//        완료 저장, 상태 전이는 러너 종료 시점에 finished/aborted)
import { NextResponse } from "next/server";
import {
  LabBatchJobBusyError,
  abortLabBatchJob,
  getLabBatchJobSnapshot,
  startLabBatchJob,
} from "@/lib/server/analysis-lab/batch-job";
import { getCunoteDb } from "@/lib/server/db/client";
import {
  DeepAnalysisRuntimeControlError,
  assertLocalSubscriptionAnalysisAllowed,
  localAnalysisOwnerFromRequest,
  renewLocalSubscriptionLease,
} from "@/lib/server/deep-analysis/runtimeControl";
import { parseLabBatchStartRequest } from "@/lib/server/analysis-lab/batch-start-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function POST(request: Request) {
  if (isProduction()) return notFound();

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseLabBatchStartRequest(body);
  if (typeof parsed === "string") {
    return NextResponse.json({ error: "invalid_request", message: parsed }, { status: 400 });
  }
  if (parsed.transport !== "claude-cli") {
    return NextResponse.json(
      {
        error: "subscription_transport_required",
        message: "로컬 분석은 claude-cli 구독 transport만 사용할 수 있습니다.",
      },
      { status: 409 },
    );
  }

  try {
    const ownerId = localAnalysisOwnerFromRequest(request);
    const db = getCunoteDb();
    await assertLocalSubscriptionAnalysisAllowed({
      db,
      ownerId,
    });
    // 시작 자체는 동기(러너는 fire-and-forget) — 202 + 시작 직후 스냅샷, 진행은 GET 폴링.
    const snapshot = startLabBatchJob(parsed, {
      keepAliveImpl: async () => {
        await renewLocalSubscriptionLease({ db, ownerId: ownerId ?? "" });
      },
    });
    return NextResponse.json(snapshot, { status: 202 });
  } catch (caught) {
    if (caught instanceof DeepAnalysisRuntimeControlError) {
      return NextResponse.json(
        { error: caught.code, message: caught.message },
        { status: caught.status },
      );
    }
    if (caught instanceof LabBatchJobBusyError) {
      return NextResponse.json(caught.snapshot, { status: 409 });
    }
    // env 오타(resolveLabTransport throw) 등 시작 전 실패 — 잡은 만들어지지 않았다.
    const message = caught instanceof Error ? caught.message : "배치 잡 시작에 실패했습니다.";
    return NextResponse.json({ error: "batch_start_failed", message }, { status: 500 });
  }
}

export async function GET() {
  if (isProduction()) return notFound();
  return NextResponse.json(getLabBatchJobSnapshot());
}

export async function DELETE() {
  if (isProduction()) return notFound();
  return NextResponse.json(abortLabBatchJob());
}

// Vercel Cron: 수집 이후(post-collection) 파이프라인(래퍼). 두 소스(kstartup·bizinfo) 수집이 끝난 뒤
// dedup 발행 → 매치 상태 갱신 → 인사이트 집계를 순서대로 실행한다. 단계 간 의존성(신선도)이 있어 개별
// cron 으로 쪼개지 않고 한 라우트에서 순차 실행한다. env 는 Vercel 이 이미 주입하므로 loadMonorepoEnv 불필요.
//
// 쓰기 모드 판단: run-grant-archive-cycle 의 프로덕션 실행(--write --with-db-steps --refresh-match-states)이
// 자동화 대상이다. publish:dedup 의 CLI 기본값이 이미 write 이므로, 세 단계의 정합성을 위해 match·insights 도
// write 로 실행한다(dry-run 이면 dedup 만 커밋되고 나머지는 무효과라 cron 목적이 무너진다). 그 외 파라미터
// (limit·minScore·asOf·staleCursorHours·companyId)는 각 CLI 기본값을 그대로 쓴다.
//
// 실패 처리: 각 단계는 커밋된 DB 상태만 읽고(메모리 핸드오프 없음) 앞 단계 성공을 하드 의존하지 않으므로,
// 한 단계가 실패해도 이후 단계를 계속 실행하고 실패를 응답에 명시한다(중단하지 않는다).
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { mockUserId } from "@/lib/server/auth/mockIdentity";
import { runDedupPublish } from "@/lib/server/ingestion/publishDedupCore";
import { runRefreshMatchStates } from "@/lib/server/matches/refreshMatchStatesCore";
import { runGrantInsights } from "@/lib/server/insights/generateGrantInsightsCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const DEFAULT_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000101";

interface StepResult {
  name: string;
  ok: boolean;
  summary: Record<string, unknown> | null;
  error: { message: string } | null;
  elapsedMs: number;
}

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const db = getCunoteDb();
  const asOf = new Date();
  const companyId = process.env.CUNOTE_DEMO_COMPANY_ID ?? DEFAULT_DEMO_COMPANY_ID;
  const userId = process.env.CUNOTE_MOCK_USER_ID ?? mockUserId();

  const steps: StepResult[] = [];
  steps.push(await runStep("publish:dedup", () =>
    runDedupPublish({ db, dryRun: false, limit: 500, minScore: undefined, asOf })
  ));
  steps.push(await runStep("match:states:refresh", () =>
    runRefreshMatchStates({ db, companyId, userId, limit: 500, asOf, write: true })
  ));
  steps.push(await runStep("insights:grants", () =>
    runGrantInsights({ db, write: true, asOf, staleCursorHours: 48 })
  ));

  const ok = steps.every((step) => step.ok);
  return NextResponse.json(
    {
      ok,
      asOf: asOf.toISOString(),
      steps,
      elapsedMs: Date.now() - startedAt,
    },
    { status: ok ? 200 : 500 },
  );
}

async function runStep(
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<StepResult> {
  const startedAt = Date.now();
  try {
    const summary = await fn();
    return { name, ok: true, summary, error: null, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name,
      ok: false,
      summary: null,
      error: { message: error instanceof Error ? error.message : String(error) },
      elapsedMs: Date.now() - startedAt,
    };
  }
}

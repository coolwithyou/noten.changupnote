"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { companyScopedFetch } from "@/lib/navigation/companyContext";

/** 대기 상태 안내(디자인 2라운드 03 poll idle). 화면을 연다고 변환이 시작되지 않는다는 사실을 먼저 알린다. */
const IDLE_CAPTION = "양식 준비는 화면을 열 때 자동으로 시작되지 않아요. 요청해야 대기 양식을 처리해요.";

/** 상세를 열기만 해서는 변환을 시작하지 않는다. 명시적 요청은 기존 bounded sweep을 사용한다. */
export function ConversionPollTrigger({ grantId }: { grantId: string }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      const response = await companyScopedFetch(`/api/web/grants/${encodeURIComponent(grantId)}/conversions/poll`, { method: "POST" });
      if (!response.ok) throw new Error(response.status === 403 ? "양식 준비를 요청하려면 회사의 편집 권한이 필요해요." : "양식 준비 상태를 확인하지 못했어요. 다시 요청할 수 있어요.");
      const result = await response.json() as { ok?: boolean; skippedReason?: string | null; previewReady?: number; failed?: number; stillPending?: number; pendingCount?: number };
      if (!result.ok || result.skippedReason) {
        setMessage("지금은 양식 준비를 실행할 수 없어요. 원본 파일을 확인하거나 나중에 다시 요청해 주세요.");
      } else {
        const ready = result.previewReady ?? 0;
        const failed = result.failed ?? 0;
        const waiting = Math.max(result.stillPending ?? 0, (result.pendingCount ?? 0) - ready - failed);
        setMessage(ready + waiting + failed > 0
          ? `준비 완료 ${ready}개 · 추가 확인 ${waiting}개 · 실패 ${failed}개. 미완료 양식은 다시 요청할 수 있어요.`
          : "현재 처리할 대기 양식이 없어요. 작성 화면에서 원본과 준비 상태를 확인해 주세요.");
        router.refresh();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "양식을 준비하지 못했어요."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div className="mt-3 flex flex-col items-center gap-2">
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void prepare()}>
      {busy ? <Spinner data-icon="inline-start" role={undefined} aria-label={undefined} aria-hidden="true" /> : null}
      {busy ? "양식 준비 상태 확인 중…" : "대기 양식 준비 요청"}
    </Button>
    {message
      ? <p role="status" className="text-center text-sm text-muted-foreground">{message}</p>
      : busy
        ? null
        : <p className="text-center text-xs text-muted-foreground">{IDLE_CAPTION}</p>}
  </div>;
}

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import type { ApplicationFieldAnalysisResult } from "@/lib/server/documents/applicationFieldAnalysis";

/** 선분석이 없거나 stale·materialization 누락인 선택 문서만 복구 분석하고 서버 화면을 다시 읽는다. */
export function ApplicationFieldAnalysisTrigger({ draftId }: { draftId: string }) {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    void (async () => {
      try {
        const response = await fetch(
          `/api/web/document-drafts/${encodeURIComponent(draftId)}/field-analysis`,
          { method: "POST" },
        );
        const payload = (await response.json()) as ActionResult<ApplicationFieldAnalysisResult>;
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "지원서 작성 항목을 분석하지 못했습니다.");
        }
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "지원서 작성 항목을 분석하지 못했습니다.");
      }
    })();
  }, [draftId, router]);

  return null;
}

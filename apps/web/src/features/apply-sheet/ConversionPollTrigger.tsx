"use client";

// 공고 상세 진입 시 해당 공고의 pending 변환을 백그라운드로 폴링한다 (계획 2026-07-08 슬라이스 A3).
// 렌더는 하지 않는다. 완료된 surface 가 생기면 router.refresh() 로 서버 컴포넌트를 다시 그려
// "문서 미리보기" 진입 링크가 나타나게 한다.
//
// 마운트당 1회만 호출한다 — 폴링 라우트 자체가 예산(45초·surface 3개)으로 보호되고,
// 미완이면 pending 으로 남아 다음 방문/일일 스윕이 회복한다.

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function ConversionPollTrigger({ grantId }: { grantId: string }) {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    // StrictMode 이중 실행 가드. 언마운트 시에도 요청은 끊지 않는다 —
    // 서버 측 변환·상태 반영이 목적이라 응답을 버려도 무해하다.
    if (firedRef.current) return;
    firedRef.current = true;

    void (async () => {
      try {
        const response = await fetch(
          `/api/web/grants/${encodeURIComponent(grantId)}/conversions/poll`,
          { method: "POST" },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { previewReady?: number };
        if ((payload.previewReady ?? 0) > 0) {
          router.refresh();
        }
      } catch {
        // 백그라운드 폴링 실패는 페이지 동작에 영향을 주지 않는다.
      }
    })();
  }, [grantId, router]);

  return null;
}

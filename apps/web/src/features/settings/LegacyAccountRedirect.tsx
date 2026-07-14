"use client";

import { useEffect } from "react";
import { legacyAccountLoginHref } from "@/lib/navigation/settingsDeepLink";

/** 기존 외부 링크의 fragment를 보존하면서 통합된 설정 화면으로 이동한다. */
export function LegacyAccountRedirect() {
  useEffect(() => {
    window.location.replace(legacyAccountLoginHref(window.location.hash));
  }, []);

  return (
    <main className="grid min-h-[50svh] place-items-center px-5 text-sm text-text-secondary">
      계정 설정으로 이동 중…
    </main>
  );
}

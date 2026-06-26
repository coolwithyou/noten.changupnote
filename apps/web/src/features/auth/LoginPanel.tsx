"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import type { WebAuthProviderSummary } from "@/lib/server/auth/options";

interface LoginPanelProps {
  callbackUrl: string;
  providers: WebAuthProviderSummary[];
}

export function LoginPanel({ callbackUrl, providers }: LoginPanelProps) {
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startSignIn(provider: WebAuthProviderSummary) {
    setPendingProvider(provider.id);
    setError(null);

    try {
      if (provider.kind === "credentials") {
        const result = await signIn(provider.id, {
          email: "demo@changupnote.com",
          redirect: false,
          callbackUrl,
        });
        if (!result?.ok) {
          throw new Error(result?.error ?? "로그인하지 못했습니다.");
        }
        window.location.assign(result.url ?? callbackUrl);
        return;
      }

      await signIn(provider.id, { callbackUrl });
    } catch (caught) {
      setPendingProvider(null);
      setError(caught instanceof Error ? caught.message : "로그인하지 못했습니다.");
    }
  }

  return (
    <main className="login-shell">
      <header className="service-nav login-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
      </header>

      <section className="login-panel" aria-labelledby="login-title">
        <p className="eyebrow">계정 연결</p>
        <h1 id="login-title">로그인</h1>
        <p>기회 맵과 신청 준비 상태를 회사별로 저장합니다.</p>

        <div className="login-provider-list">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={Boolean(pendingProvider)}
              onClick={() => startSignIn(provider)}
            >
              {pendingProvider === provider.id ? "연결 중" : `${provider.name}로 계속`}
            </button>
          ))}
          {providers.length === 0 ? (
            <p className="login-empty">활성화된 로그인 provider가 없습니다.</p>
          ) : null}
        </div>

        {error ? <p className="form-error" aria-live="polite">{error}</p> : null}
        <a className="login-return-link" href="/">처음 화면으로</a>
      </section>
    </main>
  );
}

"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

export function AdminLoginPanel({ googleEnabled }: { googleEnabled: boolean }) {
  const searchParams = useSearchParams();
  const callbackUrl = sanitizeCallback(searchParams.get("callbackUrl"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(searchParams.get("error"));

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("password");
    setError(null);
    const result = await signIn("password", { email, password, redirect: false, callbackUrl });
    if (!result?.ok) {
      setPending(null);
      setError("이메일 또는 비밀번호가 올바르지 않거나 운영자 권한이 없습니다.");
      return;
    }
    window.location.assign(result.url ?? callbackUrl);
  }

  async function submitGoogle() {
    setPending("google");
    setError(null);
    await signIn("google", { callbackUrl });
  }

  return (
    <main className="ops-auth-shell">
      <section className="ops-auth-card" aria-labelledby="admin-login-title">
        <p className="ops-eyebrow">Cunote Ops</p>
        <h1 id="admin-login-title">운영 콘솔 로그인</h1>
        <p>Google은 noten.im 계정만 허용됩니다. 사용자 프론트 세션과는 별도로 로그인합니다.</p>

        {googleEnabled ? (
          <button className="ops-button secondary" type="button" disabled={Boolean(pending)} onClick={submitGoogle}>
            {pending === "google" ? "Google 연결 중" : "Google로 계속"}
          </button>
        ) : null}

        <div className="ops-divider">이메일 로그인</div>

        <form className="ops-form" onSubmit={submitPassword}>
          {error ? <div className="ops-error">{formatError(error)}</div> : null}
          <label className="ops-field">
            <span>이메일</span>
            <input
              className="ops-input"
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(event) => setEmail(event.target.value)}
              disabled={Boolean(pending)}
            />
          </label>
          <label className="ops-field">
            <span>비밀번호</span>
            <input
              className="ops-input"
              type="password"
              value={password}
              autoComplete="current-password"
              required
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              disabled={Boolean(pending)}
            />
          </label>
          <button className="ops-button" type="submit" disabled={Boolean(pending)}>
            {pending === "password" ? "확인 중" : "로그인"}
          </button>
        </form>
      </section>
    </main>
  );
}

function sanitizeCallback(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function formatError(value: string): string {
  if (value === "AccessDenied") return "허용된 운영자 계정만 로그인할 수 있습니다.";
  if (value === "CredentialsSignin") return "이메일 또는 비밀번호가 올바르지 않습니다.";
  return "로그인하지 못했습니다.";
}

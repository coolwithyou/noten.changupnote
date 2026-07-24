"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

const GOOGLE_G_LOGO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAACXBIWXMAAAsTAAALEwB3nayOAAAAAXNSR0IB2cksfwAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABGdBTUEAALGPC/xhBQAAA1NJREFUeJyFlE1sVFUUgL/7fubNtFNaSmmb/lCxTUH52bgAoVYT1Bijpl1gJEAgQVzCwrAgrhA3EmGhYgIJiabBaEQCQRJlYYzRBcFqkURAaGhH2mkpLdAZmBnmvXc9702wljeFk5w3b+4797vnnj+lRXhY7mbRZ36AP8/D4FUYHwOloL4BOpbAmi7Ui+si2wKxHl7QP52GQ5+hb+fAJwSpABbIxCRqagB+uwxfn4K3emDdC3MD9bcfwsljUIiBYaO0MctYKVsejhjKpUaH4aN9cuh9eOnlMsAf96D6j6KTCfAE5JloXzyTvSoIipI17Qngrqgr76Lti+X6a8p4OHwUUp/CwngYKu3JNWPz5OSNqFVdsrGjZD04CCeOw5nvZa0d9h2AymQZYPp9CbjEzPHRpsavbcN88yC0ds4OcAB5dxf09EJjYwRWAk72yVPiUSOeOZq8HSf2/MfibWfEeAbcMecni4xk1ZL4GOKZ/HpNGzAXPjU37DFikf8rzGgA9FQMp3l9WcPeg26YXRVoEGd5eJIo+ReuGdrn7W5TgMV/xLxUHkoMTKe5LHB4eqYggqqMdoPJxRuBh2GjlNRQD2rk0fIoCwu7CV0YEiO5cuB64RpGrPWx0HInJKXmLd95mmLuCgWBZUX1zc9pruqO7Pl9d5Sz/UtNf6r0HrTnUml1q1j5HLemjjMtp9zUitEbX7B6wVZa5kWh/5fr0x6/pHPYpoXhi2qTzgaFZddtYWxkD+PubcZlGIxoiz/+3smO5d/REC+foFQ2T8/pIbIJB6dYie0meLY5TlO1LRVo1lC76ADnrm5jTE5J+wlGc3d4/ex6uus3sKXlDVZUtYWg4dwUfalLfHIxTcatwXHm4yqXuCryTlcitAlrYVHdVlqzFxgYOSzXTnJLV5PRVfSlf+XIaH84xaQn8b0KvGKdJK8RHQuK0QjzsW1lNatbrBlgIK88sZ8Jv4K+68fI+Enuadksn/0HBlJOyihimDmZQlkZRnFc22ZTexMfrK3/Lxyz5uHmJ/eyoGIV+4e+IX0vjy9eSR+EJRXUhlIyvoyCgHPMj7u8t3IJOzpn93xkYr/a+FqoX6V/5tTEABcyKVL5yRDalqhlWWU7XdXL2djyDDW2E0nYv3B7L9h4kUR9AAAAAElFTkSuQmCC";

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
          <button
            className="ops-google-button"
            type="button"
            disabled={Boolean(pending)}
            aria-busy={pending === "google"}
            onClick={submitGoogle}
          >
            <img
              className="ops-google-logo"
              src={GOOGLE_G_LOGO_DATA_URL}
              alt=""
              width="20"
              height="20"
              aria-hidden="true"
            />
            <span>{pending === "google" ? "Google 연결 중…" : "Google로 계속"}</span>
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

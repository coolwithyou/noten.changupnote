"use client";

import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";
import { buttonVariants, Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type { WebAuthProviderSummary } from "@/lib/server/auth/options";

interface LoginPanelProps {
  callbackUrl: string;
  providers: WebAuthProviderSummary[];
}

type Mode = "login" | "register";

export function LoginPanel({ callbackUrl, providers }: LoginPanelProps) {
  const hasPassword = providers.some((provider) => provider.id === "password");
  const oauthProviders = providers.filter((provider) => provider.kind === "oauth");
  const demoProvider = providers.find((provider) => provider.id === "demo");

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = Boolean(pending);

  async function completeSignIn() {
    const result = await signIn("password", { email, password, redirect: false, callbackUrl });
    if (!result?.ok) throw new Error("이메일 또는 비밀번호가 올바르지 않습니다.");
    window.location.assign(result.url ?? callbackUrl);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending("password");

    try {
      if (mode === "register") {
        const response = await fetch("/api/web/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name: name.trim() || undefined }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data?.error ?? "가입하지 못했습니다.");
        }
      }
      await completeSignIn();
    } catch (caught) {
      setPending(null);
      setError(caught instanceof Error ? caught.message : "처리하지 못했습니다.");
    }
  }

  async function startOAuth(provider: WebAuthProviderSummary) {
    setPending(provider.id);
    setError(null);
    try {
      await signIn(provider.id, { callbackUrl });
    } catch (caught) {
      setPending(null);
      setError(caught instanceof Error ? caught.message : "로그인하지 못했습니다.");
    }
  }

  async function startDemo() {
    setPending("demo");
    setError(null);
    try {
      const result = await signIn("demo", { email: "demo@changupnote.com", redirect: false, callbackUrl });
      if (!result?.ok) throw new Error(result?.error ?? "로그인하지 못했습니다.");
      window.location.assign(result.url ?? callbackUrl);
    } catch (caught) {
      setPending(null);
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

      <Card className="login-panel" aria-labelledby="login-title">
        <CardHeader className="p-0">
          <p className="eyebrow">계정 연결</p>
          <CardTitle id="login-title" className="text-[34px] font-bold leading-tight">
            {mode === "register" ? "회원가입" : "로그인"}
          </CardTitle>
          <p>기회 맵과 신청 준비 상태를 회사별로 저장합니다.</p>
        </CardHeader>

        <CardContent className="grid gap-4 p-0">
          {hasPassword ? (
            <form className="grid gap-3" onSubmit={onSubmit}>
              {mode === "register" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="login-name">이름 (선택)</Label>
                  <Input
                    id="login-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    disabled={busy}
                  />
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="login-email">이메일</Label>
                <Input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  disabled={busy}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="login-password">비밀번호</Label>
                <Input
                  id="login-password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  disabled={busy}
                />
              </div>
              <Button type="submit" disabled={busy}>
                {pending === "password" ? <Spinner data-icon="inline-start" /> : null}
                {pending === "password" ? "처리 중" : mode === "register" ? "가입하고 시작" : "로그인"}
              </Button>
              <Button
                type="button"
                className="h-auto min-h-0 p-0 text-sm text-muted-foreground"
                variant="link"
                disabled={busy}
                onClick={() => {
                  setMode(mode === "register" ? "login" : "register");
                  setError(null);
                }}
              >
                {mode === "register" ? "이미 계정이 있어요 · 로그인" : "처음이신가요? · 회원가입"}
              </Button>
            </form>
          ) : null}

          {hasPassword && (oauthProviders.length > 0 || demoProvider) ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              <span>또는</span>
              <Separator className="flex-1" />
            </div>
          ) : null}

          <div className="login-provider-list">
            {oauthProviders.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => startOAuth(provider)}
              >
                {pending === provider.id ? <Spinner data-icon="inline-start" /> : null}
                {pending === provider.id ? "연결 중" : `${provider.name}로 계속`}
              </Button>
            ))}
            {demoProvider ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={startDemo}>
                {pending === "demo" ? <Spinner data-icon="inline-start" /> : null}
                {pending === "demo" ? "연결 중" : "데모로 둘러보기"}
              </Button>
            ) : null}
            {!hasPassword && oauthProviders.length === 0 && !demoProvider ? (
              <p className="text-sm text-muted-foreground">활성화된 로그인 수단이 없습니다.</p>
            ) : null}
          </div>

          {error ? (
            <Alert variant="destructive" className="form-error" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <a className={buttonVariants({ variant: "ghost", size: "sm", className: "login-return-link" })} href="/">
            처음 화면으로
          </a>
        </CardContent>
      </Card>
    </main>
  );
}

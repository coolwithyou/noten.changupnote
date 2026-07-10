"use client";

import { signIn } from "next-auth/react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
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
  const [showPw, setShowPw] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = Boolean(pending);

  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();
  const legalAgreementId = useId();

  async function completeSignIn() {
    const result = await signIn("password", { email, password, redirect: false, callbackUrl });
    if (!result?.ok) throw new Error("이메일 또는 비밀번호가 올바르지 않습니다.");
    window.location.assign(result.url ?? callbackUrl);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (mode === "register" && !legalAccepted) {
      setError("이용약관과 개인정보처리방침에 동의해야 가입할 수 있습니다.");
      return;
    }
    setPending("password");

    try {
      if (mode === "register") {
        const response = await fetch("/api/web/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            name: name.trim() || undefined,
            termsAccepted: legalAccepted,
            privacyAccepted: legalAccepted,
          }),
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
    if (mode === "register" && !legalAccepted) {
      setError("이용약관과 개인정보처리방침에 동의해야 가입할 수 있습니다.");
      return;
    }
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
    <>
      <Link
        href="/"
        aria-label="창업노트 홈"
        className="mb-7 flex items-center justify-center gap-2 text-lg font-semibold text-foreground"
      >
        <AuthBrandMark className="size-7" />
        <span>창업노트</span>
      </Link>

      <Card className="[--card-spacing:--spacing(6)] border shadow-subtle ring-0 sm:[--card-spacing:--spacing(8)]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-semibold tracking-normal text-foreground">
            {mode === "register" ? "창업노트 시작하기" : "다시 오신 걸 환영해요"}
          </CardTitle>
          <CardDescription className="mt-2 text-sm leading-6">
            {mode === "register"
              ? "사업자번호로 찾은 지원사업을 저장하고 신청까지 이어가세요"
              : "사업자번호로 찾은 지원사업을 이어서 관리하세요"}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {oauthProviders.length > 0 ? (
            <Field className="mb-[22px] gap-2.5">
              {oauthProviders.map((provider) => {
                const brand = providerBrand(provider.id);
                const isPending = pending === provider.id;
                return (
                  <Button
                    key={provider.id}
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => startOAuth(provider)}
                    className={cn("h-12 w-full justify-center gap-2", brand?.className)}
                  >
                    {isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : brand?.icon}
                    {isPending ? "연결 중" : (brand?.label ?? `${provider.name}로 계속`)}
                  </Button>
                );
              })}
            </Field>
          ) : null}

          {hasPassword && oauthProviders.length > 0 ? (
            <FieldSeparator className="mb-[22px] *:data-[slot=field-separator-content]:bg-card">
              또는 이메일로
            </FieldSeparator>
          ) : null}

          {hasPassword ? (
            <form onSubmit={onSubmit}>
              <FieldGroup className="gap-3">
                {mode === "register" ? (
                  <Field>
                    <FieldLabel htmlFor={nameId}>이름 (선택)</FieldLabel>
                    <Input
                      id={nameId}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="name"
                      disabled={busy}
                      className="h-12"
                    />
                  </Field>
                ) : null}

                <Field>
                  <FieldLabel htmlFor={emailId}>이메일</FieldLabel>
                  <Input
                    id={emailId}
                    type="email"
                    required
                    placeholder="name@company.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    disabled={busy}
                    className="h-12"
                  />
                </Field>

                <Field>
                  <div className="flex items-center justify-between px-0.5">
                    <FieldLabel htmlFor={passwordId}>비밀번호</FieldLabel>
                    {mode === "login" ? (
                      <Link
                        href={`/forgot-password?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                        className="text-[12.5px] font-semibold text-primary"
                      >
                        비밀번호 찾기
                      </Link>
                    ) : null}
                  </div>
                  <InputGroup className="h-12">
                    <InputGroupInput
                      id={passwordId}
                      type={showPw ? "text" : "password"}
                      required
                      minLength={8}
                      placeholder="••••••••"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={mode === "register" ? "new-password" : "current-password"}
                      disabled={busy}
                    />
                    <InputGroupAddon align="inline-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={showPw ? "비밀번호 숨기기" : "비밀번호 표시"}
                        onClick={() => setShowPw((value) => !value)}
                      >
                        {showPw ? <EyeOff /> : <Eye />}
                      </Button>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>

                {mode === "register" ? (
                  <div className="rounded-lg border bg-muted/35 p-3">
                    <Field orientation="horizontal">
                      <Checkbox
                        id={legalAgreementId}
                        checked={legalAccepted}
                        disabled={busy}
                        aria-describedby={`${legalAgreementId}-description`}
                        onCheckedChange={(checked) => setLegalAccepted(checked === true)}
                      />
                      <FieldContent>
                        <FieldLabel
                          htmlFor={legalAgreementId}
                          className="text-[13px] font-semibold leading-[1.45] text-foreground"
                        >
                          이용약관과 개인정보처리방침에 동의합니다.
                        </FieldLabel>
                        <FieldDescription
                          id={`${legalAgreementId}-description`}
                          className="text-[12px] leading-[1.55]"
                        >
                          <Link href="/terms" className="font-semibold underline underline-offset-4">
                            이용약관
                          </Link>
                          과{" "}
                          <Link href="/privacy" className="font-semibold underline underline-offset-4">
                            개인정보처리방침
                          </Link>
                          을 확인했습니다.
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </div>
                ) : null}

                <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
                  {pending === "password" ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
                  {pending === "password" ? "처리 중" : mode === "register" ? "가입하고 시작" : "로그인"}
                </Button>
              </FieldGroup>
            </form>
          ) : null}

          {demoProvider ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={startDemo}
              className="mt-2.5 h-11 w-full"
            >
              {pending === "demo" ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              {pending === "demo" ? "연결 중" : "데모로 둘러보기"}
            </Button>
          ) : null}

          {!hasPassword && oauthProviders.length === 0 && !demoProvider ? (
            <p className="text-center text-sm text-muted-foreground">활성화된 로그인 수단이 없습니다.</p>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="mt-4" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="mt-6 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            {mode === "register" ? "이미 계정이 있으세요?" : "아직 계정이 없으세요?"}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setMode(mode === "register" ? "login" : "register");
                setError(null);
              }}
              className="h-auto p-0 font-bold text-primary hover:bg-transparent"
            >
              {mode === "register" ? "로그인" : "회원가입"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs leading-6 text-muted-foreground">
        로그인 시{" "}
        <Link href="/terms" className="font-medium underline">
          이용약관
        </Link>{" "}
        및{" "}
        <Link href="/privacy" className="font-medium underline">
          개인정보처리방침
        </Link>
        에 동의하게 됩니다.
      </p>
    </>
  );
}

function providerBrand(
  id: string,
): { label: string; icon: ReactNode; className?: string } | null {
  if (id.includes("kakao")) {
    return {
      label: "카카오로 3초 만에 시작",
      // 카카오 로그인 버튼 브랜드 가이드 고정 색상 — 테마 토큰 대상 아님(예외)
      icon: <MessageCircle data-icon="inline-start" fill="currentColor" strokeWidth={0} />,
      className: "border-transparent bg-[#FEE500] text-[#191600] hover:bg-[#FEE500]/90",
    };
  }
  if (id.includes("google")) {
    return { label: "Google로 계속하기", icon: <GoogleMark /> };
  }
  return null;
}

function GoogleMark() {
  return (
    // Google 브랜드 가이드의 4색 "G" 로고 고정 색상 — 테마 토큰 대상 아님(예외)
    <svg data-icon="inline-start" viewBox="0 0 48 48" aria-hidden role="presentation">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.98 21.98 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

export function AuthBrandMark({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden role="presentation">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--brand-mint)" />
        </linearGradient>
      </defs>
      <rect x="5" y="5" width="38" height="38" rx="11" fill={`url(#${gradientId})`} />
      <path
        d="M15.5 24.5 l5.5 5.5 l11.5 -13.5"
        stroke="white"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

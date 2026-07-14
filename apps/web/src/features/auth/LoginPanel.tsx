"use client";

import { signIn } from "next-auth/react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Eye, EyeOff, Globe2, Loader2, MessageCircle } from "lucide-react";
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
import type { WebAuthProviderSummary } from "@/lib/server/auth/options";
import { selectVisibleLoginMethods } from "./loginPresentation";

interface LoginPanelProps {
  callbackUrl: string;
  providers: WebAuthProviderSummary[];
}

type Mode = "login" | "register";

export function LoginPanel({ callbackUrl, providers }: LoginPanelProps) {
  const { hasPassword, oauthProviders } = selectVisibleLoginMethods(providers);

  const [mode, setMode] = useState<Mode>("login");
  const [emailOpen, setEmailOpen] = useState(false);
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
            3초 만에 시작해요
          </CardTitle>
          <CardDescription className="mt-2 text-sm leading-6">
            매칭 결과를 저장하고, 마감 알림을 받아보세요
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {oauthProviders.length > 0 ? (
            <Field className="gap-2.5">
              {oauthProviders.map((provider) => {
                const brand = providerBrand(provider.id);
                const isPending = pending === provider.id;
                return (
                  <Button
                    key={provider.id}
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => startOAuth(provider)}
                    className="h-12 w-full justify-center gap-2"
                  >
                    {isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : brand?.icon}
                    {isPending ? "연결 중" : (brand?.label ?? `${provider.name}로 계속하기`)}
                  </Button>
                );
              })}
            </Field>
          ) : null}

          {hasPassword && !emailOpen ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEmailOpen(true)}
              className="w-full"
            >
              이메일로 계속하기
            </Button>
          ) : null}

          {mode === "register" ? (
            <Field className="rounded-lg border bg-muted/35 p-3" orientation="horizontal">
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
                <FieldDescription id={`${legalAgreementId}-description`} className="text-[12px] leading-[1.55]">
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
          ) : null}

          {hasPassword && emailOpen ? (
            <>
              {oauthProviders.length > 0 ? (
                <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                  이메일 계정
                </FieldSeparator>
              ) : null}
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

                <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
                  {pending === "password" ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
                  {pending === "password" ? "처리 중" : mode === "register" ? "가입하고 시작" : "로그인"}
                </Button>
              </FieldGroup>
            </form>
            </>
          ) : null}

          {!hasPassword && oauthProviders.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">활성화된 로그인 수단이 없습니다.</p>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="mt-4" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
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
): { label: string; icon: ReactNode } | null {
  if (id.includes("kakao")) {
    return {
      label: "카카오로 계속하기",
      icon: <MessageCircle data-icon="inline-start" fill="currentColor" strokeWidth={0} />,
    };
  }
  if (id.includes("naver")) {
    return { label: "네이버로 계속하기", icon: <span aria-hidden>N</span> };
  }
  if (id.includes("google")) {
    return { label: "Google로 계속하기", icon: <Globe2 data-icon="inline-start" /> };
  }
  return null;
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

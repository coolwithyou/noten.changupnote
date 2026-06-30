"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, Mail } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AuthBrandMark } from "./LoginPanel";

interface PasswordResetPanelProps {
  mode: "request" | "confirm";
  token?: string | null;
  callbackUrl: string;
}

interface ResetRequestReceipt {
  accepted: true;
  persisted: boolean;
  expiresInMinutes: number;
  resetUrl: string | null;
}

interface ResetConfirmResult {
  email: string;
}

export function PasswordResetPanel({ mode, token, callbackUrl }: PasswordResetPanelProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [debugResetUrl, setDebugResetUrl] = useState<string | null>(null);
  const [resetReceipt, setResetReceipt] = useState<ResetRequestReceipt | null>(null);
  const [requestedEmail, setRequestedEmail] = useState("");
  const [handoffPending, setHandoffPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const isConfirm = mode === "confirm";

  async function onRequestSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    setDebugResetUrl(null);
    setResetReceipt(null);

    try {
      const response = await fetch("/api/web/auth/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, callbackUrl }),
      });
      const payload = await response.json().catch(() => ({})) as ActionResult<ResetRequestReceipt>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error?.message ?? "재설정 요청을 처리하지 못했습니다.");
      }
      setMessage("계정이 확인되면 비밀번호 재설정 안내를 받을 수 있습니다.");
      setDebugResetUrl(payload.data?.resetUrl ?? null);
      setResetReceipt(payload.data ?? null);
      setRequestedEmail(email);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "재설정 요청을 처리하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  async function downloadResetEmailHandoff() {
    if (!debugResetUrl || !resetReceipt) return;
    setHandoffPending(true);
    setError(null);
    try {
      const response = await fetch("/api/web/auth/password-reset/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: requestedEmail,
          resetUrl: debugResetUrl,
          expiresInMinutes: resetReceipt.expiresInMinutes,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ActionResult<null> | null;
        throw new Error(payload?.error?.message ?? "비밀번호 재설정 메일 파일을 만들지 못했습니다.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fallbackPasswordResetFilename(requestedEmail);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "비밀번호 재설정 메일 파일을 만들지 못했습니다.");
    } finally {
      setHandoffPending(false);
    }
  }

  async function onConfirmSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setError("재설정 링크가 올바르지 않거나 만료되었습니다.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("새 비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/web/auth/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const payload = await response.json().catch(() => ({})) as ActionResult<ResetConfirmResult>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error?.message ?? "비밀번호를 변경하지 못했습니다.");
      }
      setComplete(true);
      setMessage("비밀번호가 변경되었습니다. 새 비밀번호로 로그인하세요.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "비밀번호를 변경하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      className="cunote-auth relative flex min-h-screen w-full items-center justify-center overflow-hidden px-5 py-10"
      style={{ backgroundImage: "var(--grad-mesh)", fontFamily: "var(--font-cunote-sans)" }}
    >
      <div className="cunote-grain" aria-hidden />

      <div className="relative z-[2] w-full max-w-[420px]">
        <Link
          href="/"
          aria-label="창업노트 홈"
          className="mb-7 flex items-center justify-center gap-2.5 text-[18px] font-extrabold tracking-[-0.03em] text-[var(--tds-grey-900)]"
        >
          <AuthBrandMark className="size-[27px]" />
          <span>창업노트</span>
        </Link>

        <div className="rounded-[var(--tds-radius-l)] border border-border bg-card p-8 shadow-[var(--shadow-elevated)]">
          <div className="mb-7 text-center">
            <h1 className="mb-2 text-[24px] font-extrabold tracking-[-0.03em] text-[var(--tds-grey-900)]">
              {isConfirm ? "새 비밀번호 설정" : "비밀번호 찾기"}
            </h1>
            <p className="text-[14.5px] leading-[1.5] text-[var(--tds-grey-500)]">
              {isConfirm
                ? "재설정 링크가 유효하면 새 비밀번호로 계정을 보호할 수 있습니다"
                : "가입한 이메일을 입력하면 재설정 안내를 확인할 수 있습니다"}
            </p>
          </div>

          {isConfirm ? (
            <form className="flex flex-col gap-4" onSubmit={onConfirmSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="newPassword">새 비밀번호</FieldLabel>
                  <Input
                    id="newPassword"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    disabled={pending || complete}
                    className="h-[50px] rounded-[var(--tds-radius-xxs)]"
                  />
                  <FieldDescription>8자 이상 입력해주세요.</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="newPasswordConfirm">새 비밀번호 확인</FieldLabel>
                  <Input
                    id="newPasswordConfirm"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={passwordConfirm}
                    onChange={(event) => setPasswordConfirm(event.currentTarget.value)}
                    disabled={pending || complete}
                    className="h-[50px] rounded-[var(--tds-radius-xxs)]"
                  />
                </Field>
              </FieldGroup>

              <Button type="submit" size="lg" disabled={pending || complete || !token} className="h-[54px] rounded-[var(--tds-radius-xxs)]">
                {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
                {pending ? "변경 중" : "비밀번호 변경"}
              </Button>
            </form>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={onRequestSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="resetEmail">이메일</FieldLabel>
                  <Input
                    id="resetEmail"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    disabled={pending}
                    className="h-[50px] rounded-[var(--tds-radius-xxs)]"
                  />
                </Field>
              </FieldGroup>

              <Button type="submit" size="lg" disabled={pending} className="h-[54px] rounded-[var(--tds-radius-xxs)]">
                {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
                {pending ? "요청 중" : "재설정 안내 받기"}
              </Button>
            </form>
          )}

          {message ? (
            <Alert className="mt-4" aria-live="polite">
              <CheckCircle2 data-icon="inline-start" />
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}

          {debugResetUrl ? (
            <div className="mt-3 grid gap-2">
              <Link
                href={debugResetUrl}
                className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full rounded-[var(--tds-radius-xxs)]")}
              >
                재설정 링크 열기
              </Link>
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full rounded-[var(--tds-radius-xxs)]"
                disabled={handoffPending}
                onClick={() => void downloadResetEmailHandoff()}
              >
                {handoffPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Mail data-icon="inline-start" />}
                메일 파일
              </Button>
            </div>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="mt-4" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="mt-[22px] flex items-center justify-center gap-1.5 text-[13.5px] text-[var(--tds-grey-500)]">
            <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="font-bold text-primary">
              로그인으로 돌아가기
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

function fallbackPasswordResetFilename(email: string): string {
  const safeEmail = email
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "password-reset";
  return `창업노트-${safeEmail}-비밀번호재설정.eml`;
}

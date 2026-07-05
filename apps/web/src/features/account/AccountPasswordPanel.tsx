"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type PasswordChangeMode = "changed" | "created";

interface PasswordChangeResult {
  changed: true;
  mode: PasswordChangeMode;
}

export function AccountPasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<"currentPassword" | "newPassword" | "newPasswordConfirm" | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setErrorField(null);

    if (newPassword !== newPasswordConfirm) {
      setError("새 비밀번호가 서로 일치하지 않습니다.");
      setErrorField("newPasswordConfirm");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/web/account/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = await response.json().catch(() => ({})) as ActionResult<PasswordChangeResult>;
      if (!response.ok || !payload.ok) {
        const field = payload.error?.field;
        if (field === "currentPassword" || field === "newPassword") setErrorField(field);
        throw new Error(payload.error?.message ?? "비밀번호를 변경하지 못했습니다.");
      }
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setMessage(payload.data?.mode === "created"
        ? "이메일 비밀번호가 설정되었습니다."
        : "비밀번호가 변경되었습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "비밀번호를 변경하지 못했습니다.");
      setErrorField((current) => current ?? null);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>비밀번호 변경</CardTitle>
        <CardDescription>이메일 로그인용 비밀번호를 설정하거나 변경합니다.</CardDescription>
        <CardAction>
          <KeyRound className="text-muted-foreground" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="accountCurrentPassword">현재 비밀번호</FieldLabel>
              <Input
                id="accountCurrentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                aria-describedby={errorField === "currentPassword" ? "accountCurrentPasswordError accountCurrentPasswordDescription" : "accountCurrentPasswordDescription"}
                aria-invalid={errorField === "currentPassword"}
                onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                disabled={pending}
              />
              <FieldDescription id="accountCurrentPasswordDescription">OAuth로만 가입한 계정은 비워둔 채 새 비밀번호를 설정할 수 있습니다.</FieldDescription>
              {errorField === "currentPassword" && error ? <FieldError id="accountCurrentPasswordError">{error}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="accountNewPassword">새 비밀번호</FieldLabel>
              <Input
                id="accountNewPassword"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                aria-describedby={errorField === "newPassword" ? "accountNewPasswordError" : undefined}
                aria-invalid={errorField === "newPassword"}
                onChange={(event) => setNewPassword(event.currentTarget.value)}
                disabled={pending}
              />
              {errorField === "newPassword" && error ? <FieldError id="accountNewPasswordError">{error}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="accountNewPasswordConfirm">새 비밀번호 확인</FieldLabel>
              <Input
                id="accountNewPasswordConfirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={newPasswordConfirm}
                aria-describedby={errorField === "newPasswordConfirm" ? "accountNewPasswordConfirmError" : undefined}
                aria-invalid={errorField === "newPasswordConfirm"}
                onChange={(event) => setNewPasswordConfirm(event.currentTarget.value)}
                disabled={pending}
              />
              {errorField === "newPasswordConfirm" && error ? <FieldError id="accountNewPasswordConfirmError">{error}</FieldError> : null}
            </Field>
          </FieldGroup>

          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {pending ? "변경 중" : "비밀번호 변경"}
          </Button>
        </form>

        {message ? (
          <Alert className="mt-4" aria-live="polite">
            <CheckCircle2 data-icon="inline-start" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}

        {error && !errorField ? (
          <Alert variant="destructive" className="mt-4" aria-live="polite">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

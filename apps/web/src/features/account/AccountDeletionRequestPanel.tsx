"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Mail, Send } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import type { AccountDeletionRequestHistoryItem } from "@/lib/server/account/accountDeletionRequestHistory";
import { StatusBadge } from "@/components/app/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface SupportTicketReceipt {
  id: string;
  status: "open" | "queued";
  receivedAt: string;
  persisted: boolean;
}

export function AccountDeletionRequestPanel({
  email,
  history,
}: {
  email?: string | null;
  history: AccountDeletionRequestHistoryItem[];
}) {
  const [contactEmail, setContactEmail] = useState(email ?? "");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<"email" | "confirmation" | null>(null);
  const [receipt, setReceipt] = useState<SupportTicketReceipt | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function requestConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrorField(null);
    setReceipt(null);
    if (confirmation.trim() !== "삭제 요청") {
      setErrorField("confirmation");
      setError("확인 문구에 '삭제 요청'을 정확히 입력해주세요.");
      return;
    }
    setConfirmOpen(true);
  }

  async function runDeletionRequest() {
    setPending(true);
    setError(null);
    setErrorField(null);
    try {
      const response = await fetch("/api/web/account/deletion-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: contactEmail,
          reason,
          confirmation,
        }),
      });
      const payload = await response.json() as ActionResult<SupportTicketReceipt>;
      if (!response.ok || !payload.ok || !payload.data) {
        const field = payload.error?.field;
        if (field === "email" || field === "confirmation") setErrorField(field);
        throw new Error(payload.error?.message ?? "삭제 요청을 접수하지 못했습니다.");
      }
      setReceipt(payload.data);
      setReason("");
      setConfirmation("");
      setConfirmOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "삭제 요청을 접수하지 못했습니다.");
      setConfirmOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card id="account-deletion-request">
      <CardHeader>
        <CardTitle>계정 데이터 삭제 요청</CardTitle>
        <CardDescription>삭제는 회사 권한, 법적 보존 의무, 진행 중인 고객지원 기록을 확인한 뒤 처리됩니다.</CardDescription>
        <CardAction>
          <AlertTriangle className="text-destructive" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex gap-3 rounded-[var(--radius-lg)] border bg-destructive/5 p-4 text-sm leading-6 text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>즉시 계정을 삭제하지 않고 개인정보 요청 티켓으로 접수합니다. 운영팀이 보존 대상과 회사 접근권한을 확인합니다.</span>
        </div>
        <form className="flex flex-col gap-4" onSubmit={requestConfirm}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-deletion-email">처리 결과를 받을 이메일</FieldLabel>
              <Input
                id="account-deletion-email"
                type="email"
                autoComplete="email"
                value={contactEmail}
                onChange={(event) => setContactEmail(event.currentTarget.value)}
                placeholder="you@company.com"
                aria-describedby={errorField === "email" ? "account-deletion-email-error" : undefined}
                aria-invalid={errorField === "email"}
                disabled={pending}
                required
              />
              {errorField === "email" && error ? <FieldError id="account-deletion-email-error">{error}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="account-deletion-reason">요청 사유</FieldLabel>
              <Textarea
                id="account-deletion-reason"
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value)}
                placeholder="삭제 또는 처리 정지를 요청하는 이유를 적어주세요."
                disabled={pending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-deletion-confirmation">확인 문구</FieldLabel>
              <Input
                id="account-deletion-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
                placeholder="삭제 요청"
                aria-describedby={errorField === "confirmation"
                  ? "account-deletion-confirmation-description account-deletion-confirmation-error"
                  : "account-deletion-confirmation-description"}
                aria-invalid={errorField === "confirmation"}
                disabled={pending}
                required
              />
              <FieldDescription id="account-deletion-confirmation-description">
                계정 데이터 삭제 또는 처리 정지를 요청하려면 <strong>삭제 요청</strong>을 그대로 입력하세요.
              </FieldDescription>
              {errorField === "confirmation" && error ? <FieldError id="account-deletion-confirmation-error">{error}</FieldError> : null}
            </Field>
          </FieldGroup>
          {error && !errorField ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
          {receipt ? (
            <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border bg-muted/30 px-3 py-2 text-sm text-foreground" role="status">
              <CheckCircle2 aria-hidden />
              <span>접수번호 {receipt.id}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
              삭제 요청 접수
            </Button>
            <a className={buttonVariants({ variant: "secondary" })} href="/api/web/account/deletion-request/handoff">
              <Mail data-icon="inline-start" />
              메일 파일
            </a>
          </div>
        </form>
        <div className="grid gap-3" aria-label="최근 삭제 요청">
          <div>
            <span className="text-xs font-medium text-muted-foreground">최근 삭제 요청</span>
            <h3 className="text-base font-semibold text-foreground">처리 상태</h3>
          </div>
          {history.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
              <strong className="block text-sm font-semibold text-foreground">아직 접수된 삭제 요청이 없습니다.</strong>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                삭제 또는 처리 정지 요청을 남기면 이곳에서 접수 상태와 최근 업데이트를 확인할 수 있습니다.
              </p>
            </div>
          ) : (
            history.map((request) => (
              <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border p-4 md:grid-cols-[minmax(0,1fr)_auto]" key={request.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-semibold text-foreground">{request.subject}</strong>
                    <StatusBadge tone={statusTone(request.status)}>{statusLabel(request.status)}</StatusBadge>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{request.messagePreview}</p>
                  <span className="mt-2 block text-xs font-bold text-muted-foreground">
                    {request.email} · {formatDate(request.requestedAt)}
                  </span>
                </div>
                <div className="grid gap-1 text-sm md:text-right">
                  <span className="font-semibold text-foreground">최근 업데이트 {formatDate(request.updatedAt)}</span>
                  <span className="text-muted-foreground">
                    {request.responseDueAt ? `응답 기준 ${formatDate(request.responseDueAt)}` : "응답 기준 조정중"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>계정 데이터 삭제 요청을 접수할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              즉시 삭제하지 않고 개인정보 요청 티켓으로 접수합니다. 운영팀이 보존 대상과 회사 접근권한을 확인한 뒤 처리하며, 결과는 {contactEmail || "입력한 이메일"}로 안내됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void runDeletionRequest()}
            >
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
              삭제 요청 접수
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function statusTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "open" || status === "in_progress") return "brand";
  if (status === "waiting") return "warning";
  if (status === "resolved" || status === "closed") return "success";
  return "neutral";
}

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "답변 완료";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

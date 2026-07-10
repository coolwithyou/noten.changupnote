"use client";

import { useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Mail, Paperclip, Send } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type SupportTicketCategory = "product" | "account" | "privacy" | "billing" | "bug" | "coaching";

interface SupportTicketReceipt {
  id: string;
  status: "open" | "queued";
  receivedAt: string;
  persisted: boolean;
  emailDelivery?: {
    provider: string;
    configured: boolean;
    status: string;
  };
}

interface SupportTicketAttachmentReceipt {
  persisted: boolean;
  storageConfigured: boolean;
  message: string;
}

interface SupportTicketHandoffSnapshot {
  category: SupportTicketCategory;
  email: string;
  name: string;
  subject: string;
  message: string;
  ticketId: string;
  hasAttachment: boolean;
  attachmentFilename: string | null;
}

const CATEGORY_ITEMS: Array<{
  value: SupportTicketCategory;
  label: string;
}> = [
  { value: "product", label: "제품 문의" },
  { value: "account", label: "계정/회사 권한" },
  { value: "privacy", label: "개인정보/삭제 요청" },
  { value: "billing", label: "플랜/청구" },
  { value: "bug", label: "오류 신고" },
  { value: "coaching", label: "작성 코칭 신청" },
];

export function SupportTicketForm({
  defaultEmail,
  defaultName,
  accountSupportHref,
  accountSupportLabel = "내 문의 보기",
  initialCategory = "product",
  initialSubject = "",
  initialMessage = "",
}: {
  defaultEmail?: string | null;
  defaultName?: string | null;
  accountSupportHref?: string;
  accountSupportLabel?: string;
  /** 공고 상세 등에서 진입 시 prefill (계획 2026-07-08 슬라이스 C). */
  initialCategory?: SupportTicketCategory;
  initialSubject?: string;
  initialMessage?: string;
}) {
  const [category, setCategory] = useState<SupportTicketCategory>(initialCategory);
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [name, setName] = useState(defaultName ?? "");
  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState(initialMessage);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [receipt, setReceipt] = useState<SupportTicketReceipt | null>(null);
  const [handoffSnapshot, setHandoffSnapshot] = useState<SupportTicketHandoffSnapshot | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setAttachmentNotice(null);
    setReceipt(null);
    setHandoffSnapshot(null);
    try {
      const submitted = {
        category,
        email,
        name,
        subject,
        message,
      };
      const response = await fetch("/api/web/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitted),
      });
      const payload = await response.json() as ActionResult<SupportTicketReceipt>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "문의를 접수하지 못했습니다.");
      }
      const uploadedFile = fileInputRef.current?.files?.[0] ?? null;
      const attachmentMessage = uploadedFile
        ? await uploadAttachment({
          ticketId: payload.data.id,
          email,
          file: uploadedFile,
          persisted: payload.data.persisted,
        })
        : null;
      setReceipt(payload.data);
      toast.success(`문의가 접수되었습니다. 접수번호 ${payload.data.id}`);
      setHandoffSnapshot({
        ...submitted,
        ticketId: payload.data.id,
        hasAttachment: Boolean(uploadedFile),
        attachmentFilename: uploadedFile?.name ?? null,
      });
      setAttachmentNotice(attachmentMessage);
      setSubject("");
      setMessage("");
      if (fileInputRef.current && (!uploadedFile || attachmentMessage?.ok)) {
        fileInputRef.current.value = "";
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "문의를 접수하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  async function downloadHandoff() {
    if (!handoffSnapshot) return;
    setHandoffPending(true);
    setError(null);
    try {
      const response = await fetch("/api/web/support/tickets/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(handoffSnapshot),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ActionResult<null> | null;
        throw new Error(payload?.error?.message ?? "문의 메일 파일을 만들지 못했습니다.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fallbackHandoffFilename(handoffSnapshot);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "문의 메일 파일을 만들지 못했습니다.");
    } finally {
      setHandoffPending(false);
    }
  }

  return (
    <Card id="support-ticket-form">
      <CardHeader>
        <CardTitle>운영팀에 문의하기</CardTitle>
        <CardDescription>계정, 회사 인증, 매칭 결과, 신청서류 초안 문제를 하나의 티켓으로 접수합니다.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="support-email">이메일</FieldLabel>
                <Input
                  id="support-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  placeholder="you@company.com"
                  disabled={pending}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="support-name">이름</FieldLabel>
                <Input
                  id="support-name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder="홍길동"
                  disabled={pending}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="support-category">문의 유형</FieldLabel>
              <Select
                items={CATEGORY_ITEMS}
                value={category}
                disabled={pending}
                onValueChange={(value) => {
                  if (typeof value === "string" && isCategory(value)) setCategory(value);
                }}
              >
                <SelectTrigger id="support-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CATEGORY_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="support-subject">제목</FieldLabel>
              <Input
                id="support-subject"
                value={subject}
                onChange={(event) => setSubject(event.currentTarget.value)}
                placeholder="무엇을 도와드릴까요?"
                disabled={pending}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="support-message">내용</FieldLabel>
              <Textarea
                id="support-message"
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
                placeholder="문제가 발생한 화면, 회사명, 공고명, 기대한 결과를 함께 적어주세요."
                disabled={pending}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="support-attachment">
                <Paperclip aria-hidden />
                첨부 파일
              </FieldLabel>
              <Input
                ref={fileInputRef}
                id="support-attachment"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.log,.csv,.hwp,.hwpx,.doc,.docx"
                disabled={pending}
              />
            </Field>
          </FieldGroup>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {receipt ? (
            <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border bg-muted/30 p-4 text-sm text-foreground" role="status">
              <CheckCircle2 aria-hidden />
              <span>
                접수번호 {receipt.id}
                {!receipt.persisted ? " · 저장소 연결 후 운영팀이 확인합니다." : ""}
              </span>
              <span className={receipt.emailDelivery?.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                {supportTicketDeliveryMessage(receipt)}
              </span>
              {attachmentNotice ? (
                <span className={attachmentNotice.ok ? "text-muted-foreground" : "text-destructive"}>
                  {attachmentNotice.message}
                </span>
              ) : null}
              {receipt.persisted && accountSupportHref ? (
                <a
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: "w-fit",
                  })}
                  href={accountSupportHref}
                >
                  {accountSupportLabel}
                </a>
              ) : null}
              {handoffSnapshot ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={handoffPending}
                  onClick={() => void downloadHandoff()}
                >
                  {handoffPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Mail data-icon="inline-start" />}
                  메일 파일
                </Button>
              ) : null}
            </div>
          ) : null}

          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
            문의 접수
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

async function uploadAttachment(input: {
  ticketId: string;
  email: string;
  file: File;
  persisted: boolean;
}): Promise<{ ok: boolean; message: string }> {
  if (!input.persisted) {
    return {
      ok: false,
      message: "문의 저장소 연결 후 첨부 파일을 함께 보관할 수 있습니다.",
    };
  }

  try {
    const formData = new FormData();
    formData.set("email", input.email);
    formData.set("file", input.file);
    const response = await fetch(`/api/web/support/tickets/${encodeURIComponent(input.ticketId)}/attachments`, {
      method: "POST",
      body: formData,
    });
    const payload = await response.json() as ActionResult<SupportTicketAttachmentReceipt>;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "첨부 파일을 보관하지 못했습니다.");
    }
    return {
      ok: payload.data.persisted,
      message: payload.data.message,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "첨부 파일을 보관하지 못했습니다.",
    };
  }
}

function isCategory(value: string): value is SupportTicketCategory {
  return CATEGORY_ITEMS.some((item) => item.value === value);
}

function fallbackHandoffFilename(snapshot: SupportTicketHandoffSnapshot): string {
  const safeSubject = snapshot.subject
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "support-ticket";
  return `창업노트-${safeSubject}-문의메일.eml`;
}

function supportTicketDeliveryMessage(receipt: SupportTicketReceipt): string {
  if (receipt.emailDelivery?.status === "delivered") return "지원팀에 이메일로 전달했습니다.";
  if (receipt.emailDelivery?.status === "failed") return "이메일 전달은 실패했습니다. 메일 파일로 이어서 보낼 수 있습니다.";
  return "지원팀 전달용 메일 파일을 만들 수 있습니다.";
}

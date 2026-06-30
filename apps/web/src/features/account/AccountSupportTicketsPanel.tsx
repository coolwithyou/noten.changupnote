"use client";

import { useState } from "react";
import { CheckCircle2, Download, LifeBuoy, MessageSquareReply, Paperclip, RotateCcw, Send, Trash2 } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import type {
  AccountSupportTicketItem,
  SupportTicketMessageReceipt,
  UserSupportTicketStatusResult,
} from "@/lib/server/support/supportTicketMessages";
import type { SupportTicketAttachmentItem } from "@/lib/server/support/supportTicketAttachments";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export function AccountSupportTicketsPanel({
  tickets,
}: {
  tickets: AccountSupportTicketItem[];
}) {
  const [rows, setRows] = useState(tickets);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingAttachmentId, setPendingAttachmentId] = useState<string | null>(null);
  const [pendingStatusId, setPendingStatusId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitReply(ticketId: string) {
    const body = drafts[ticketId]?.trim();
    if (!body) {
      setNotice("답장 내용을 입력해주세요.");
      return;
    }
    setPendingId(ticketId);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/support/tickets/${encodeURIComponent(ticketId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const payload = await response.json() as ActionResult<SupportTicketMessageReceipt>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "답장을 저장하지 못했습니다.");
      }
      setRows((current) => current.map((ticket) =>
        ticket.id === ticketId ? appendMessage(ticket, payload.data!) : ticket
      ));
      setDrafts((current) => ({ ...current, [ticketId]: "" }));
      setNotice("답장을 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "답장을 저장하지 못했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  async function archiveAttachment(ticketId: string, attachmentId: string) {
    setPendingAttachmentId(attachmentId);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/web/support/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { method: "DELETE" },
      );
      const payload = await response.json() as ActionResult<{
        persisted: boolean;
        attachment: SupportTicketAttachmentItem | null;
        message: string;
      }>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "첨부 파일 보관 상태를 변경하지 못했습니다.");
      }
      setRows((current) => current.map((ticket) =>
        ticket.id === ticketId
          ? {
            ...ticket,
            attachments: ticket.attachments.filter((attachment) => attachment.id !== attachmentId),
          }
          : ticket
      ));
      setNotice(payload.data.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "첨부 파일 보관 상태를 변경하지 못했습니다.");
    } finally {
      setPendingAttachmentId(null);
    }
  }

  async function updateStatus(ticketId: string, action: "resolve" | "reopen") {
    setPendingStatusId(ticketId);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/support/tickets/${encodeURIComponent(ticketId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as ActionResult<UserSupportTicketStatusResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "문의 상태를 저장하지 못했습니다.");
      }
      setRows((current) => current.map((ticket) =>
        ticket.id === ticketId
          ? {
            ...ticket,
            status: payload.data!.status,
            updatedAt: payload.data!.updatedAt,
          }
          : ticket
      ));
      setNotice(payload.data.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "문의 상태를 저장하지 못했습니다.");
    } finally {
      setPendingStatusId(null);
    }
  }

  return (
    <Card id="account-support-tickets" className="saas-panel account-support-panel">
      <CardHeader>
        <div>
          <span className="eyebrow">내 문의</span>
          <h2>고객지원 기록</h2>
        </div>
        <StatusBadge tone={rows.length > 0 ? "brand" : "neutral"}>{rows.length}</StatusBadge>
      </CardHeader>
      <CardContent className="account-support-content">
        {rows.length === 0 ? (
          <div className="account-support-empty">
            <LifeBuoy aria-hidden />
            <strong>아직 접수된 문의가 없습니다.</strong>
            <p>제품, 계정, 결제, 개인정보 문의를 남기면 이곳에서 처리 상태를 이어서 확인할 수 있습니다.</p>
            <a className={buttonVariants({ variant: "secondary", size: "sm" })} href="/support">
              문의 남기기
            </a>
          </div>
        ) : (
          <div className="account-support-list">
            {rows.map((ticket) => (
              <article className="account-support-ticket-row" key={ticket.id}>
                <div className="account-support-ticket-header">
                  <div>
                    <span>{ticket.category} · {formatDate(ticket.lastPublicMessageAt)}</span>
                    <strong>{ticket.subject}</strong>
                    <p>{ticket.lastPublicMessagePreview}</p>
                    {ticket.responseDueAt ? (
                      <em>예상 응답 기준 {formatDateOnly(ticket.responseDueAt)}</em>
                    ) : null}
                  </div>
                  <StatusBadge tone={statusTone(ticket.status)}>{statusLabel(ticket.status)}</StatusBadge>
                </div>
                <div className="account-support-thread" aria-label={`${ticket.subject} 문의 대화`}>
                  {ticket.thread.map((message) => (
                    <div
                      className={`account-support-message ${message.authorType === "admin" ? "from-admin" : "from-user"}`}
                      key={message.id}
                    >
                      <strong>{message.authorType === "admin" ? "창업노트" : "나"}</strong>
                      <p>{message.body}</p>
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                  ))}
                </div>
                {ticket.attachments.length > 0 ? (
                  <div className="account-support-attachments" aria-label={`${ticket.subject} 문의 첨부 파일`}>
                    <span>
                      <Paperclip aria-hidden />
                      첨부 파일 {ticket.attachments.length}개
                    </span>
                    <div>
                      {ticket.attachments.map((attachment) => (
                        <div className="account-support-attachment-item" key={attachment.id}>
                          <a
                            className={buttonVariants({
                              variant: "outline",
                              size: "sm",
                              className: "account-support-attachment-link",
                            })}
                            href={attachment.archiveUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Download data-icon="inline-start" />
                            <span>{attachment.filename}</span>
                            <small>{attachment.sizeLabel}</small>
                          </a>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${attachment.filename} 보관 해제`}
                            disabled={pendingAttachmentId === attachment.id}
                            onClick={() => void archiveAttachment(ticket.id, attachment.id)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="account-support-ticket-actions">
                  {ticket.status === "resolved" || ticket.status === "closed" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={pendingStatusId === ticket.id}
                      onClick={() => void updateStatus(ticket.id, "reopen")}
                    >
                      <RotateCcw data-icon="inline-start" />
                      다시 열기
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={pendingStatusId === ticket.id}
                      onClick={() => void updateStatus(ticket.id, "resolve")}
                    >
                      <CheckCircle2 data-icon="inline-start" />
                      해결됨 표시
                    </Button>
                  )}
                  <a
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    href={`/api/web/support/tickets/${encodeURIComponent(ticket.id)}/transcript`}
                  >
                    <Download data-icon="inline-start" />
                    대화 내려받기
                  </a>
                </div>
                <form
                  className="account-support-reply-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitReply(ticket.id);
                  }}
                >
                  <Textarea
                    value={drafts[ticket.id] ?? ""}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [ticket.id]: event.target.value,
                    }))}
                    placeholder="추가로 전달할 내용을 입력해주세요."
                    aria-label={`${ticket.subject} 문의 답장`}
                  />
                  <Button type="submit" size="sm" disabled={pendingId === ticket.id}>
                    <Send data-icon="inline-start" />
                    답장 저장
                  </Button>
                </form>
              </article>
            ))}
          </div>
        )}
        {notice ? (
          <p className="account-support-notice">
            <CheckCircle2 aria-hidden />
            {notice}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function appendMessage(
  ticket: AccountSupportTicketItem,
  message: SupportTicketMessageReceipt,
): AccountSupportTicketItem {
  const appended = {
    id: message.id,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt,
  };
  const nextThread = [...ticket.thread, appended].slice(-4);
  return {
    ...ticket,
    status: nextUserReplyStatus(ticket.status),
    updatedAt: message.createdAt,
    publicMessageCount: ticket.publicMessageCount + 1,
    lastPublicMessageAt: message.createdAt,
    lastPublicMessagePreview: preview(message.body),
    thread: nextThread,
  };
}

function nextUserReplyStatus(status: string): string {
  if (status === "resolved" || status === "closed" || status === "waiting") return "open";
  return status;
}

function statusTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "resolved" || status === "closed") return "success";
  if (status === "waiting") return "warning";
  if (status === "in_progress") return "brand";
  if (status === "open") return "neutral";
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
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

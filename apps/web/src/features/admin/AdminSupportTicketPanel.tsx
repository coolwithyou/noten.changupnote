"use client";

import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, Download, MessageSquareReply, RotateCcw, Save, UserRound } from "lucide-react";
import type { ApiEnvelope } from "@cunote/contracts";
import type { AdminSupportTicketItem } from "@/lib/server/admin/flywheelStore";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
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

type SupportTicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
type SupportTicketPriority = "low" | "normal" | "high" | "urgent";
type SupportTicketMessageVisibility = "public" | "internal";
type SupportTicketStatusFilter = "all" | SupportTicketStatus;
type SupportTicketPriorityFilter = "all" | SupportTicketPriority;
type SupportTicketSlaFilter = "all" | AdminSupportTicketItem["slaStatus"];

const STATUS_OPTIONS: Array<{ value: SupportTicketStatus; label: string }> = [
  { value: "open", label: "열림" },
  { value: "in_progress", label: "처리중" },
  { value: "waiting", label: "대기" },
  { value: "resolved", label: "해결" },
  { value: "closed", label: "종료" },
];

const PRIORITY_OPTIONS: Array<{ value: SupportTicketPriority; label: string }> = [
  { value: "low", label: "낮음" },
  { value: "normal", label: "보통" },
  { value: "high", label: "높음" },
  { value: "urgent", label: "긴급" },
];
const VISIBILITY_OPTIONS: Array<{ value: SupportTicketMessageVisibility; label: string }> = [
  { value: "public", label: "고객 답변" },
  { value: "internal", label: "내부 메모" },
];
const SLA_FILTER_OPTIONS: Array<{ value: SupportTicketSlaFilter; label: string }> = [
  { value: "all", label: "전체 SLA" },
  { value: "overdue", label: "SLA 초과" },
  { value: "due_soon", label: "임박" },
  { value: "ok", label: "정상" },
  { value: "none", label: "SLA 없음" },
];

export function AdminSupportTicketPanel({
  tickets,
}: {
  tickets: AdminSupportTicketItem[];
}) {
  const [rows, setRows] = useState(() => tickets.map(toEditableTicket));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [messagePendingId, setMessagePendingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [visibilities, setVisibilities] = useState<Record<string, SupportTicketMessageVisibility>>({});
  const [statusFilter, setStatusFilter] = useState<SupportTicketStatusFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<SupportTicketPriorityFilter>("all");
  const [slaFilter, setSlaFilter] = useState<SupportTicketSlaFilter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const filteredRows = useMemo(() => rows.filter((ticket) => matchesTicketFilters(ticket, {
    status: statusFilter,
    priority: priorityFilter,
    sla: slaFilter,
    assignee: assigneeFilter,
  })), [assigneeFilter, priorityFilter, rows, slaFilter, statusFilter]);
  const visibleRows = filteredRows.slice(0, 5);
  const hasActiveFilters = statusFilter !== "all"
    || priorityFilter !== "all"
    || slaFilter !== "all"
    || assigneeFilter.trim().length > 0;

  async function save(ticketId: string) {
    const row = rows.find((item) => item.id === ticketId);
    if (!row) return;
    setPendingId(ticketId);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/flywheel/support-tickets/${encodeURIComponent(ticketId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: row.status,
          priority: row.priority,
          assignedTo: row.assignedTo ?? "",
          slaDueAt: row.slaDueAt ?? "",
          note: "admin flywheel quick action",
        }),
      });
      const payload = await response.json() as ApiEnvelope<{
        id: string;
        status: SupportTicketStatus;
        priority: SupportTicketPriority;
        assignedTo: string | null;
        slaDueAt: string | null;
      }>;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "지원 티켓을 저장하지 못했습니다.");
      }
      setRows((current) => current.map((item) =>
        item.id === payload.data!.id
          ? {
            ...item,
            status: payload.data!.status,
            priority: payload.data!.priority,
            assignedTo: payload.data!.assignedTo,
            slaDueAt: payload.data!.slaDueAt,
            slaStatus: slaStatus(payload.data!.slaDueAt),
            dirty: false,
          }
          : item
      ));
      setNotice("지원 티켓 상태를 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "지원 티켓을 저장하지 못했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  async function saveMessage(ticketId: string) {
    const row = rows.find((item) => item.id === ticketId);
    const body = drafts[ticketId]?.trim();
    if (!row || !body) {
      setNotice("답변 또는 메모 내용을 입력해주세요.");
      return;
    }
    const visibility = visibilities[ticketId] ?? "public";
    setMessagePendingId(ticketId);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/flywheel/support-tickets/${encodeURIComponent(ticketId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, visibility }),
      });
      const payload = await response.json() as ApiEnvelope<{
        id: string;
        ticketId: string;
        visibility: SupportTicketMessageVisibility;
        body: string;
        createdAt: string;
      }>;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "답변 또는 메모를 저장하지 못했습니다.");
      }
      setRows((current) => current.map((item) =>
        item.id === payload.data!.ticketId
          ? {
            ...item,
            status: payload.data!.visibility === "public" ? "waiting" : item.status,
            dirty: false,
            messageCount: item.messageCount + 1,
            lastMessageAt: payload.data!.createdAt,
            lastMessagePreview: preview(payload.data!.body),
            lastMessageVisibility: payload.data!.visibility,
          }
          : item
      ));
      setDrafts((current) => ({ ...current, [ticketId]: "" }));
      setNotice(visibility === "public" ? "고객 답변을 저장했습니다." : "내부 메모를 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "답변 또는 메모를 저장하지 못했습니다.");
    } finally {
      setMessagePendingId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <section className="admin-support-panel">
        <div className="admin-support-panel-heading">
          <div>
            <h3>support_tickets</h3>
            <p>최근 고객지원 큐를 Markdown으로 내려받아 운영 회의에 공유할 수 있습니다.</p>
          </div>
          <div className="admin-support-panel-actions">
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/admin/flywheel/support-tickets/report">
              <Download data-icon="inline-start" />
              운영 큐
            </a>
            <StatusBadge tone="neutral">0</StatusBadge>
          </div>
        </div>
        <p>처리할 고객지원 티켓이 없습니다.</p>
      </section>
    );
  }

  function resetFilters() {
    setStatusFilter("all");
    setPriorityFilter("all");
    setSlaFilter("all");
    setAssigneeFilter("");
  }

  return (
    <section className="admin-support-panel">
      <div className="admin-support-panel-heading">
        <div>
          <h3>support_tickets</h3>
          <p>최근 고객지원 큐를 Markdown으로 내려받아 운영 회의에 공유할 수 있습니다.</p>
        </div>
        <div className="admin-support-panel-actions">
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/admin/flywheel/support-tickets/report">
            <Download data-icon="inline-start" />
            운영 큐
          </a>
          <StatusBadge tone={filteredRows.length > 0 ? "brand" : "neutral"}>
            {hasActiveFilters ? `${filteredRows.length}/${rows.length}` : rows.length}
          </StatusBadge>
        </div>
      </div>
      <div className="admin-support-filters" aria-label="지원 티켓 필터">
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as SupportTicketStatusFilter)}
        >
          <SelectTrigger size="sm" className="admin-support-filter-select" aria-label="상태 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">전체 상태</SelectItem>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={priorityFilter}
          onValueChange={(value) => setPriorityFilter(value as SupportTicketPriorityFilter)}
        >
          <SelectTrigger size="sm" className="admin-support-filter-select" aria-label="우선순위 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">전체 우선순위</SelectItem>
              {PRIORITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={slaFilter}
          onValueChange={(value) => setSlaFilter(value as SupportTicketSlaFilter)}
        >
          <SelectTrigger size="sm" className="admin-support-filter-select" aria-label="SLA 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SLA_FILTER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <label className="admin-support-filter-search">
          <span><UserRound aria-hidden /> 담당자</span>
          <Input
            value={assigneeFilter}
            onChange={(event) => setAssigneeFilter(event.currentTarget.value)}
            placeholder="담당자 검색"
            aria-label="담당자 필터"
          />
        </label>
        {hasActiveFilters ? (
          <Button type="button" size="sm" variant="ghost" onClick={resetFilters}>
            <RotateCcw data-icon="inline-start" />
            초기화
          </Button>
        ) : null}
      </div>
      <div className="admin-support-ticket-list">
        {visibleRows.length === 0 ? (
          <div className="admin-support-filter-empty">
            <p>조건에 맞는 고객지원 티켓이 없습니다.</p>
          </div>
        ) : visibleRows.map((ticket) => (
          <article className="admin-support-ticket-row" key={ticket.id}>
            <div className="admin-support-ticket-main">
              <strong>{ticket.subject}</strong>
              <span>{ticket.category} · {ticket.email}</span>
              <em>{ticket.messagePreview}</em>
              {ticket.lastMessagePreview ? (
                <small>
                  최근 {ticket.lastMessageVisibility === "internal" ? "내부 메모" : "메시지"} · {ticket.lastMessagePreview}
                </small>
              ) : null}
              <small>
                담당 {ticket.assignedTo || "미지정"} · SLA {ticket.slaDueAt || "미설정"}
              </small>
              {ticket.attachmentCount > 0 ? (
                <small>
                  첨부 {ticket.attachmentCount}개
                  {ticket.lastAttachmentUrl && ticket.lastAttachmentFilename ? (
                    <>
                      {" · "}
                      <a href={ticket.lastAttachmentUrl} target="_blank" rel="noreferrer">
                        <Download aria-hidden />
                        {ticket.lastAttachmentFilename}
                      </a>
                    </>
                  ) : null}
                </small>
              ) : null}
            </div>
            <Select
              value={ticket.status}
              onValueChange={(value) => updateRow(ticket.id, { status: value as SupportTicketStatus })}
            >
              <SelectTrigger size="sm" className="admin-support-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={ticket.priority}
              onValueChange={(value) => updateRow(ticket.id, { priority: value as SupportTicketPriority })}
            >
              <SelectTrigger size="sm" className="admin-support-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PRIORITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!ticket.dirty || pendingId === ticket.id}
              onClick={() => void save(ticket.id)}
            >
              <Save data-icon="inline-start" />
              저장
            </Button>
            <a
              className={buttonVariants({ variant: "outline", size: "sm" })}
              href={`/api/admin/flywheel/support-tickets/${encodeURIComponent(ticket.id)}/email-handoff`}
            >
              <Download data-icon="inline-start" />
              이메일
            </a>
            <div className="admin-support-assignment-form">
              <label>
                <span><UserRound aria-hidden /> 담당자</span>
                <Input
                  value={ticket.assignedTo ?? ""}
                  onChange={(event) => updateRow(ticket.id, { assignedTo: event.currentTarget.value })}
                  placeholder="운영 담당자"
                />
              </label>
              <label>
                <span><CalendarClock aria-hidden /> SLA</span>
                <Input
                  type="date"
                  value={ticket.slaDueAt ?? ""}
                  onChange={(event) => updateRow(ticket.id, { slaDueAt: event.currentTarget.value })}
                />
              </label>
              <StatusBadge tone={slaTone(ticket.slaStatus)}>{slaLabel(ticket.slaStatus)}</StatusBadge>
            </div>
            <form
              className="admin-support-reply-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveMessage(ticket.id);
              }}
            >
              <Textarea
                value={drafts[ticket.id] ?? ""}
                onChange={(event) => setDrafts((current) => ({
                  ...current,
                  [ticket.id]: event.target.value,
                }))}
                placeholder="고객에게 보낼 답변 또는 내부 처리 메모를 입력하세요."
                aria-label={`${ticket.subject} 답변 또는 내부 메모`}
              />
              <div className="admin-support-reply-actions">
                <Select
                  value={visibilities[ticket.id] ?? "public"}
                  onValueChange={(value) => setVisibilities((current) => ({
                    ...current,
                    [ticket.id]: value as SupportTicketMessageVisibility,
                  }))}
                >
                  <SelectTrigger size="sm" className="admin-support-visibility-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {VISIBILITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <span>{ticket.messageCount}개 메시지</span>
                <Button
                  type="submit"
                  size="sm"
                  disabled={messagePendingId === ticket.id}
                >
                  <MessageSquareReply data-icon="inline-start" />
                  저장
                </Button>
              </div>
            </form>
          </article>
        ))}
      </div>
      {filteredRows.length > visibleRows.length ? (
        <p className="admin-support-list-caption">
          {filteredRows.length}개 중 최근 {visibleRows.length}개 표시
        </p>
      ) : null}
      {notice ? (
        <p className="admin-support-notice">
          <CheckCircle2 aria-hidden />
          {notice}
        </p>
      ) : null}
    </section>
  );

  function updateRow(
    ticketId: string,
    patch: Partial<Pick<EditableTicket, "status" | "priority" | "assignedTo" | "slaDueAt">>,
  ) {
    setRows((current) => current.map((item) =>
      item.id === ticketId
        ? {
          ...item,
          ...patch,
          slaStatus: patch.slaDueAt === undefined ? item.slaStatus : slaStatus(patch.slaDueAt),
          dirty: true,
        }
        : item
    ));
  }
}

function matchesTicketFilters(
  ticket: EditableTicket,
  filters: {
    status: SupportTicketStatusFilter;
    priority: SupportTicketPriorityFilter;
    sla: SupportTicketSlaFilter;
    assignee: string;
  },
): boolean {
  if (filters.status !== "all" && ticket.status !== filters.status) return false;
  if (filters.priority !== "all" && ticket.priority !== filters.priority) return false;
  if (filters.sla !== "all" && ticket.slaStatus !== filters.sla) return false;
  const assignee = filters.assignee.trim().toLowerCase();
  if (!assignee) return true;
  const value = ticket.assignedTo?.trim().toLowerCase() || "미지정";
  return value.includes(assignee);
}

interface EditableTicket extends AdminSupportTicketItem {
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  assignedTo: string | null;
  slaDueAt: string | null;
  dirty: boolean;
}

function toEditableTicket(ticket: AdminSupportTicketItem): EditableTicket {
  return {
    ...ticket,
    status: statusValue(ticket.status),
    priority: priorityValue(ticket.priority),
    dirty: false,
  };
}

function statusValue(value: string): SupportTicketStatus {
  return STATUS_OPTIONS.some((option) => option.value === value) ? value as SupportTicketStatus : "open";
}

function priorityValue(value: string): SupportTicketPriority {
  return PRIORITY_OPTIONS.some((option) => option.value === value) ? value as SupportTicketPriority : "normal";
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function slaStatus(value: string | null): AdminSupportTicketItem["slaStatus"] {
  if (!value) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(value);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 1) return "due_soon";
  return "ok";
}

function slaTone(status: AdminSupportTicketItem["slaStatus"]): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "overdue") return "danger";
  if (status === "due_soon") return "warning";
  if (status === "ok") return "success";
  return "neutral";
}

function slaLabel(status: AdminSupportTicketItem["slaStatus"]): string {
  if (status === "overdue") return "SLA 초과";
  if (status === "due_soon") return "임박";
  if (status === "ok") return "정상";
  return "SLA 없음";
}

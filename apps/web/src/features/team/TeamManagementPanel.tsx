"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Check, Copy, History, Link2, Mail, RefreshCw, Send, ShieldCheck, XCircle } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorkspaceMember, WorkspaceOverview } from "@/lib/server/workspace/overview";

type TeamInvitation = WorkspaceOverview["invitations"][number];
type TeamRoleChangeEvent = WorkspaceOverview["roleChangeEvents"][number];
type TeamRole = "admin" | "member" | "viewer";
type NoticeTone = "success" | "warning" | "danger" | "neutral";

const ROLE_OPTIONS: Array<{ value: TeamRole; label: string; description: string }> = [
  { value: "admin", label: "관리자", description: "팀 초대와 설정 변경 가능" },
  { value: "member", label: "멤버", description: "신청 준비와 초안 편집 가능" },
  { value: "viewer", label: "뷰어", description: "조회 중심 접근" },
];

export function TeamManagementPanel({
  members,
  invitations,
  roleChangeEvents,
  seatUsage,
  currentUserRole,
}: {
  members: WorkspaceMember[];
  invitations: TeamInvitation[];
  roleChangeEvents: TeamRoleChangeEvent[];
  seatUsage: WorkspaceOverview["seatUsage"];
  currentUserRole: string;
}) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [memberRows, setMemberRows] = useState(members);
  const [invitationRows, setInvitationRows] = useState(invitations);
  const [roleEventRows, setRoleEventRows] = useState(roleChangeEvents);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, TeamRole>>(() => roleDraftState(members));
  const [lastInvite, setLastInvite] = useState<TeamInvitation | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [actingInvitationId, setActingInvitationId] = useState<string | null>(null);
  const pendingInvitationCount = useMemo(
    () => invitationRows.filter(isSeatHoldingInvitation).length,
    [invitationRows],
  );
  const reservedSeatCount = memberRows.length + pendingInvitationCount;
  const availableSeatCount = Math.max(0, seatUsage.seatLimit - reservedSeatCount);
  const seatLimitReached = availableSeatCount <= 0;
  const seatUsagePercent = Math.min(100, Math.round((reservedSeatCount / seatUsage.seatLimit) * 100));

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    if (seatLimitReached) {
      setNotice({ tone: "warning", message: "현재 플랜의 팀 좌석을 모두 사용했습니다." });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/web/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const payload = await response.json() as ActionResult<TeamInvitation>;
      if (!payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초대를 만들지 못했습니다.");
      }
      setInvitationRows((current) => [payload.data!, ...current.filter((item) => item.id !== payload.data!.id)]);
      setLastInvite(payload.data);
      setEmail("");
      const deliveryStatus = payload.data.emailDelivery?.status;
      setNotice({
        tone: payload.data.persisted && deliveryStatus !== "failed" ? "success" : "warning",
        message: inviteNoticeMessage(payload.data),
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "초대를 만들지 못했습니다.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function resendInvitation(invitation: TeamInvitation) {
    if (!canManage || actingInvitationId) return;
    setActingInvitationId(invitation.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/team/invitations/${encodeURIComponent(invitation.id)}/resend`, {
        method: "POST",
      });
      const payload = await response.json() as ActionResult<TeamInvitation>;
      if (!payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초대 링크를 재발행하지 못했습니다.");
      }
      setInvitationRows((current) => current.map((item) =>
        item.id === payload.data!.id ? payload.data! : item
      ));
      setLastInvite(payload.data);
      setNotice({
        tone: payload.data.emailDelivery?.status === "failed" ? "warning" : "success",
        message: resendNoticeMessage(payload.data),
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "초대 링크를 재발행하지 못했습니다.",
      });
    } finally {
      setActingInvitationId(null);
    }
  }

  async function revokeInvitation(invitation: TeamInvitation) {
    if (!canManage || actingInvitationId) return;
    setActingInvitationId(invitation.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/team/invitations/${encodeURIComponent(invitation.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json() as ActionResult<TeamInvitation>;
      if (!payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초대를 철회하지 못했습니다.");
      }
      setInvitationRows((current) => current.map((item) =>
        item.id === payload.data!.id ? payload.data! : item
      ));
      if (lastInvite?.id === payload.data.id) setLastInvite(payload.data);
      setNotice({ tone: "success", message: "초대를 철회했습니다." });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "초대를 철회하지 못했습니다.",
      });
    } finally {
      setActingInvitationId(null);
    }
  }

  async function updateRole(member: WorkspaceMember) {
    const nextRole = roleDrafts[member.userId];
    if (!canManage || !nextRole || nextRole === member.role || member.currentUser || member.role === "owner") return;
    setUpdatingUserId(member.userId);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/team/members/${encodeURIComponent(member.userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const payload = await response.json() as ActionResult<{
        userId: string;
        role: TeamRole;
        roleChangeEvent: TeamRoleChangeEvent | null;
      }>;
      if (!payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "역할을 저장하지 못했습니다.");
      }
      setMemberRows((current) => current.map((row) =>
        row.userId === payload.data!.userId ? { ...row, role: payload.data!.role } : row
      ));
      if (payload.data.roleChangeEvent) {
        setRoleEventRows((current) => [
          payload.data!.roleChangeEvent!,
          ...current.filter((event) => event.id !== payload.data!.roleChangeEvent!.id),
        ].slice(0, 12));
      }
      setNotice({ tone: "success", message: "멤버 역할을 저장했습니다." });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "역할을 저장하지 못했습니다.",
      });
    } finally {
      setUpdatingUserId(null);
    }
  }

  async function copyInviteUrl(inviteUrl: string | null | undefined = lastInvite?.inviteUrl) {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setNotice({ tone: "success", message: "초대 링크를 복사했습니다." });
  }

  return (
    <div className="team-management-panel" id="team-invite-panel">
      <div className="team-invite-panel">
        <div className="team-panel-heading">
          <div>
            <span className="eyebrow">초대</span>
            <h3>팀원을 링크로 초대</h3>
          </div>
          <StatusBadge tone={pendingInvitationCount > 0 ? "brand" : "neutral"}>
            대기 {pendingInvitationCount}
          </StatusBadge>
        </div>

        <div className="team-seat-summary" aria-label="팀 좌석 사용량">
          <div>
            <span>좌석 {reservedSeatCount.toLocaleString("ko-KR")}/{seatUsage.seatLimit.toLocaleString("ko-KR")}</span>
            <p>
              멤버 {memberRows.length.toLocaleString("ko-KR")}명 · 대기 {pendingInvitationCount.toLocaleString("ko-KR")}명 · 남은 {availableSeatCount.toLocaleString("ko-KR")}명
            </p>
          </div>
          <div className="team-seat-meter" aria-hidden>
            <span style={{ width: `${seatUsagePercent}%` }} />
          </div>
        </div>

        {canManage ? (
          <form className="team-invite-form" onSubmit={submitInvitation}>
            <Field>
              <FieldLabel htmlFor="team-invite-email">이메일</FieldLabel>
              <Input
                id="team-invite-email"
                type="email"
                value={email}
                placeholder="member@company.com"
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-invite-role">역할</FieldLabel>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as TeamRole)}>
                <SelectTrigger id="team-invite-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {ROLE_OPTIONS.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {role.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {seatLimitReached
                  ? "남은 좌석이 없어 새 초대를 만들 수 없습니다."
                  : ROLE_OPTIONS.find((role) => role.value === inviteRole)?.description}
              </FieldDescription>
            </Field>
            <Button type="submit" disabled={submitting || seatLimitReached}>
              <Send data-icon="inline-start" />
              {submitting ? "생성 중" : "초대 링크 생성"}
            </Button>
          </form>
        ) : (
          <div className="team-permission-note">
            <ShieldCheck aria-hidden />
            <p>팀 초대와 역할 변경은 소유자 또는 관리자만 사용할 수 있습니다.</p>
          </div>
        )}

        {lastInvite ? (
          <div className="team-invite-result">
            {lastInvite.inviteUrl ? (
              <>
                <Input readOnly value={lastInvite.inviteUrl} aria-label="초대 링크" />
                <Button type="button" variant="secondary" onClick={() => copyInviteUrl(lastInvite.inviteUrl)}>
                  <Copy data-icon="inline-start" />
                  복사
                </Button>
                <a className={buttonVariants({ variant: "outline" })} href={inviteEmailHandoffHref(lastInvite.inviteUrl)}>
                  <Mail data-icon="inline-start" />
                  메일 파일
                </a>
              </>
            ) : (
              <p>마이그레이션과 DB 연결이 완료되면 초대 링크가 발급됩니다.</p>
            )}
          </div>
        ) : null}

        {notice ? (
          <FieldError className={`team-notice team-notice-${notice.tone}`}>
            {notice.tone === "success" ? <Check aria-hidden /> : null}
            {notice.message}
          </FieldError>
        ) : null}
      </div>

      <div className="team-section-list" aria-label="팀 멤버 목록">
        {memberRows.map((member) => (
          <div className="team-member-row" key={member.userId}>
            <div className="team-member-avatar" aria-hidden>
              {memberInitial(member)}
            </div>
            <div className="team-member-main">
              <strong>{member.name}</strong>
              <span>
                <Mail aria-hidden />
                {member.email ?? "이메일 없음"}
              </span>
            </div>
            <MemberRoleControl
              member={member}
              canManage={canManage}
              value={roleDrafts[member.userId] ?? "viewer"}
              pending={updatingUserId === member.userId}
              onValueChange={(value) => setRoleDrafts((current) => ({ ...current, [member.userId]: value }))}
              onSave={() => updateRole(member)}
            />
          </div>
        ))}
      </div>

      {invitationRows.length > 0 ? (
        <details className="saas-disclosure">
          <summary>
            <span className="saas-disclosure-summary-copy">
              <span className="eyebrow">초대 이력</span>
              <strong>최근 초대</strong>
            </span>
            <StatusBadge tone="neutral">{invitationRows.length}</StatusBadge>
          </summary>
          <div className="saas-disclosure-content team-invitation-list" aria-label="팀 초대 이력">
            {invitationRows.map((invitation) => (
              <div className="team-invitation-row" key={invitation.id}>
                <div>
                  <strong>{invitation.email}</strong>
                  <span>{roleLabel(invitation.role)} · {dateLabel(invitation.expiresAt)}까지</span>
                </div>
                <div className="team-invitation-actions">
                  <StatusBadge tone={invitation.status === "pending" ? "brand" : "neutral"}>
                    {invitationStatusLabel(invitation.status)}
                  </StatusBadge>
                  {invitation.inviteUrl ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => copyInviteUrl(invitation.inviteUrl)}
                      >
                        <Link2 data-icon="inline-start" />
                        복사
                      </Button>
                      <a
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                        href={inviteEmailHandoffHref(invitation.inviteUrl)}
                      >
                        <Mail data-icon="inline-start" />
                        메일 파일
                      </a>
                    </>
                  ) : null}
                  {canManage && invitation.persisted && (invitation.status === "pending" || invitation.status === "expired") ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={actingInvitationId === invitation.id || (invitation.status === "expired" && seatLimitReached)}
                      onClick={() => resendInvitation(invitation)}
                    >
                      <RefreshCw data-icon="inline-start" />
                      재발행
                    </Button>
                  ) : null}
                  {canManage && invitation.persisted && invitation.status === "pending" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actingInvitationId === invitation.id}
                      onClick={() => revokeInvitation(invitation)}
                    >
                      <XCircle data-icon="inline-start" />
                      철회
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {canManage ? (
        <details className="saas-disclosure">
          <summary>
            <span className="saas-disclosure-summary-copy">
              <span className="eyebrow">감사 로그</span>
              <strong>권한 변경 이력</strong>
            </span>
            <StatusBadge tone={roleEventRows.length > 0 ? "brand" : "neutral"}>
              최근 {roleEventRows.length.toLocaleString("ko-KR")}
            </StatusBadge>
          </summary>
          <div className="saas-disclosure-content team-role-history" aria-label="권한 변경 이력">
            {roleEventRows.length > 0 ? (
              <div className="team-role-history-list">
                {roleEventRows.map((event) => (
                  <div className="team-role-history-row" key={event.id}>
                    <span className="team-role-history-icon" aria-hidden>
                      <History />
                    </span>
                    <div>
                      <strong>{event.targetName}</strong>
                      <p>
                        {roleLabel(event.previousRole)}에서 {roleLabel(event.nextRole)}로 변경
                        · {event.actorName} · {dateTimeLabel(event.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="team-role-history-empty">
                <span className="team-role-history-icon" aria-hidden>
                  <History />
                </span>
                <p>아직 기록된 권한 변경이 없습니다.</p>
              </div>
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MemberRoleControl({
  member,
  canManage,
  value,
  pending,
  onValueChange,
  onSave,
}: {
  member: WorkspaceMember;
  canManage: boolean;
  value: TeamRole;
  pending: boolean;
  onValueChange: (value: TeamRole) => void;
  onSave: () => void;
}) {
  if (member.currentUser) return <StatusBadge tone="brand">나 · {roleLabel(member.role)}</StatusBadge>;
  if (member.role === "owner") return <StatusBadge tone="neutral">소유자</StatusBadge>;

  const changed = value !== member.role;
  if (!canManage) return <StatusBadge tone="neutral">{roleLabel(member.role)}</StatusBadge>;

  return (
    <div className="team-member-role-form">
      <Select value={value} onValueChange={(nextValue) => onValueChange(nextValue as TeamRole)}>
        <SelectTrigger size="sm" className="team-role-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {ROLE_OPTIONS.map((role) => (
              <SelectItem key={role.value} value={role.value}>
                {role.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button type="button" size="sm" variant="secondary" disabled={!changed || pending} onClick={onSave}>
        {pending ? "저장 중" : "저장"}
      </Button>
    </div>
  );
}

function roleDraftState(members: WorkspaceMember[]): Record<string, TeamRole> {
  return Object.fromEntries(
    members
      .filter((member) => member.role !== "owner")
      .map((member) => [member.userId, member.role as TeamRole]),
  );
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}

function invitationStatusLabel(status: string): string {
  if (status === "accepted") return "수락";
  if (status === "revoked") return "철회";
  if (status === "expired") return "만료";
  return "대기";
}

function isSeatHoldingInvitation(invitation: TeamInvitation): boolean {
  return invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > Date.now();
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function inviteEmailHandoffHref(inviteUrl: string): string {
  try {
    const url = new URL(inviteUrl);
    const token = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return `/api/web/team/invitations/handoff/${encodeURIComponent(token)}`;
  } catch {
    const token = inviteUrl.split("/").filter(Boolean).at(-1) ?? "";
    return `/api/web/team/invitations/handoff/${encodeURIComponent(token)}`;
  }
}

function inviteNoticeMessage(invitation: TeamInvitation): string {
  if (!invitation.persisted) return "현재 환경에서는 초대가 임시 대기 상태로 기록됩니다.";
  if (invitation.emailDelivery?.status === "delivered") return "초대 링크를 만들고 이메일을 보냈습니다.";
  if (invitation.emailDelivery?.status === "failed") return "초대 링크를 만들었지만 이메일 발송은 실패했습니다. 메일 파일 또는 링크 복사를 사용하세요.";
  return "초대 링크를 만들었습니다.";
}

function resendNoticeMessage(invitation: TeamInvitation): string {
  if (invitation.emailDelivery?.status === "delivered") return "초대 링크를 다시 만들고 이메일을 보냈습니다.";
  if (invitation.emailDelivery?.status === "failed") return "초대 링크를 다시 만들었지만 이메일 발송은 실패했습니다.";
  return "초대 링크를 다시 만들었습니다.";
}

function memberInitial(member: WorkspaceMember): string {
  const first = (member.name || member.email || "?")[0] ?? "?";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

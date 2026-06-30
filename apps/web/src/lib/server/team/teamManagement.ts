import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt } from "drizzle-orm";
import type { CompanyRole } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb, withCunoteDbUser, type CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { getOutboundEmailProviderStatus, sendOutboundEmail, type OutboundEmailDeliveryResult } from "@/lib/server/email/outboundEmail";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import { EARLY_ACCESS_LIMITS } from "@/lib/server/workspace/limits";
import {
  renderTeamInvitationEmailText,
  TEAM_INVITATION_EMAIL_TAG,
  teamInvitationEmailSubject,
} from "./teamInvitationEmailHandoff";

export type TeamManagedRole = Exclude<CompanyRole, "owner">;
export type TeamInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface TeamInvitationRecord {
  id: string;
  email: string;
  role: TeamManagedRole;
  status: TeamInvitationStatus;
  expiresAt: string;
  createdAt: string;
  inviteUrl: string | null;
  persisted: boolean;
  emailDelivery: OutboundEmailDeliveryResult;
}

export interface TeamInvitationAcceptance {
  companyId: string;
  role: TeamManagedRole;
  acceptedAt: string;
}

export interface TeamRoleChangeEventRecord {
  id: string;
  companyId: string;
  targetUserId: string | null;
  targetName: string;
  targetEmail: string | null;
  previousRole: CompanyRole;
  nextRole: CompanyRole;
  actorUserId: string | null;
  actorName: string;
  actorEmail: string | null;
  source: string;
  createdAt: string;
  persisted: boolean;
}

export interface TeamMemberRoleUpdate {
  userId: string;
  role: TeamManagedRole;
  roleChangeEvent: TeamRoleChangeEventRecord | null;
}

export interface TeamSeatUsage {
  activeSeats: number;
  pendingInvitations: number;
  reservedSeats: number;
  seatLimit: number;
  availableSeats: number;
}

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MANAGED_ROLES: TeamManagedRole[] = ["admin", "member", "viewer"];

export class TeamManagementError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "TeamManagementError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

export async function createTeamInvitation(input: {
  access: CompanyAccess;
  email: string;
  role: TeamManagedRole;
  origin: string;
}): Promise<TeamInvitationRecord> {
  assertTeamAdmin(input.access);
  const email = normalizeEmail(input.email);
  const role = normalizeRole(input.role);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const token = randomToken();
  const tokenHash = hashToken(token);

  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    return fallbackInvitation({ email, role, origin: input.origin, now, expiresAt });
  }

  try {
    const db = getCunoteDb();
    const row = await withCunoteDbUser(db, input.access.userId, async (tx) => {
      await assertTeamSeatAvailable({
        tx,
        companyId: input.access.companyId,
        pendingSeatDelta: 1,
        now,
      });
      const [created] = await tx
        .insert(schema.teamInvitations)
        .values({
          companyId: input.access.companyId,
          email,
          role,
          tokenHash,
          status: "pending",
          invitedBy: input.access.userId,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: schema.teamInvitations.id,
          email: schema.teamInvitations.email,
          role: schema.teamInvitations.role,
          status: schema.teamInvitations.status,
          expiresAt: schema.teamInvitations.expiresAt,
          createdAt: schema.teamInvitations.createdAt,
        });
      if (!created) return null;
      const [company] = await tx
        .select({ name: schema.companies.name })
        .from(schema.companies)
        .where(eq(schema.companies.id, input.access.companyId))
        .limit(1);
      return { ...created, companyName: company?.name ?? null };
    });
    if (!row) return fallbackInvitation({ email, role, origin: input.origin, now, expiresAt });
    return toInvitationRecordWithDelivery({
      row,
      inviteUrl: buildInviteUrl(input.origin, token),
      persisted: true,
      companyName: row.companyName,
    });
  } catch (error) {
    if (error instanceof TeamManagementError) throw error;
    return fallbackInvitation({ email, role, origin: input.origin, now, expiresAt });
  }
}

export async function listTeamInvitations(input: {
  access: CompanyAccess;
}): Promise<TeamInvitationRecord[]> {
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return [];

  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select({
        id: schema.teamInvitations.id,
        email: schema.teamInvitations.email,
        role: schema.teamInvitations.role,
        status: schema.teamInvitations.status,
        expiresAt: schema.teamInvitations.expiresAt,
        createdAt: schema.teamInvitations.createdAt,
      })
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.companyId, input.access.companyId))
      .orderBy(desc(schema.teamInvitations.createdAt))
      .limit(20));
    return rows.map((row) => toInvitationRecord(row, null, true));
  } catch {
    return [];
  }
}

export async function listTeamRoleChangeEvents(input: {
  access: CompanyAccess;
  limit?: number;
}): Promise<TeamRoleChangeEventRecord[]> {
  if (!canManageTeam(input.access) || input.access.mode === "demo" || !hasDatabaseUrl()) return [];

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select({
        id: schema.teamRoleChangeEvents.id,
        companyId: schema.teamRoleChangeEvents.companyId,
        targetUserId: schema.teamRoleChangeEvents.targetUserId,
        actorUserId: schema.teamRoleChangeEvents.actorUserId,
        previousRole: schema.teamRoleChangeEvents.previousRole,
        nextRole: schema.teamRoleChangeEvents.nextRole,
        targetSnapshot: schema.teamRoleChangeEvents.targetSnapshot,
        actorSnapshot: schema.teamRoleChangeEvents.actorSnapshot,
        source: schema.teamRoleChangeEvents.source,
        createdAt: schema.teamRoleChangeEvents.createdAt,
      })
      .from(schema.teamRoleChangeEvents)
      .where(eq(schema.teamRoleChangeEvents.companyId, input.access.companyId))
      .orderBy(desc(schema.teamRoleChangeEvents.createdAt))
      .limit(limit));
    return rows.map((row) => toRoleChangeEventRecord(row, true));
  } catch {
    return [];
  }
}

export async function resendTeamInvitation(input: {
  access: CompanyAccess;
  invitationId: string;
  origin: string;
}): Promise<TeamInvitationRecord> {
  assertTeamAdmin(input.access);
  const invitationId = normalizeUuid(input.invitationId, "invitationId");
  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    throw new TeamManagementError("team_invitation_resend_unavailable", "현재 환경에서는 초대 링크를 재발행할 수 없습니다.", 503);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const token = randomToken();
  const tokenHash = hashToken(token);
  const db = getCunoteDb();

  const row = await withCunoteDbUser(db, input.access.userId, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(schema.teamInvitations)
      .where(and(
        eq(schema.teamInvitations.id, invitationId),
        eq(schema.teamInvitations.companyId, input.access.companyId),
      ))
      .limit(1);

    if (!invitation) {
      throw new TeamManagementError("team_invitation_not_found", "초대를 찾지 못했습니다.", 404, "invitationId");
    }

    const status = effectiveInvitationStatus(invitation.status, invitation.expiresAt, now);
    if (status === "accepted" || status === "revoked") {
      throw new TeamManagementError("team_invitation_not_resendable", "이미 처리된 초대는 재발행할 수 없습니다.", 409, "invitationId");
    }

    await assertTeamSeatAvailable({
      tx,
      companyId: input.access.companyId,
      pendingSeatDelta: status === "expired" ? 1 : 0,
      now,
    });

    const [updated] = await tx
      .update(schema.teamInvitations)
      .set({
        tokenHash,
        status: "pending",
        acceptedBy: null,
        acceptedAt: null,
        expiresAt,
        updatedAt: now,
      })
      .where(eq(schema.teamInvitations.id, invitationId))
      .returning({
        id: schema.teamInvitations.id,
        email: schema.teamInvitations.email,
        role: schema.teamInvitations.role,
        status: schema.teamInvitations.status,
        expiresAt: schema.teamInvitations.expiresAt,
        createdAt: schema.teamInvitations.createdAt,
      });

    if (!updated) {
      throw new TeamManagementError("team_invitation_resend_failed", "초대 링크를 재발행하지 못했습니다.", 500);
    }
    const [company] = await tx
      .select({ name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.id, input.access.companyId))
      .limit(1);
    return { ...updated, companyName: company?.name ?? null };
  });

  return toInvitationRecordWithDelivery({
    row,
    inviteUrl: buildInviteUrl(input.origin, token),
    persisted: true,
    companyName: row.companyName,
  });
}

export async function revokeTeamInvitation(input: {
  access: CompanyAccess;
  invitationId: string;
}): Promise<TeamInvitationRecord> {
  assertTeamAdmin(input.access);
  const invitationId = normalizeUuid(input.invitationId, "invitationId");
  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    throw new TeamManagementError("team_invitation_revoke_unavailable", "현재 환경에서는 초대를 철회할 수 없습니다.", 503);
  }

  const now = new Date();
  const db = getCunoteDb();
  const row = await withCunoteDbUser(db, input.access.userId, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(schema.teamInvitations)
      .where(and(
        eq(schema.teamInvitations.id, invitationId),
        eq(schema.teamInvitations.companyId, input.access.companyId),
      ))
      .limit(1);

    if (!invitation) {
      throw new TeamManagementError("team_invitation_not_found", "초대를 찾지 못했습니다.", 404, "invitationId");
    }

    const status = effectiveInvitationStatus(invitation.status, invitation.expiresAt, now);
    if (status !== "pending") {
      throw new TeamManagementError("team_invitation_not_revocable", "대기 중인 초대만 철회할 수 있습니다.", 409, "invitationId");
    }

    const [updated] = await tx
      .update(schema.teamInvitations)
      .set({
        status: "revoked",
        updatedAt: now,
      })
      .where(eq(schema.teamInvitations.id, invitationId))
      .returning({
        id: schema.teamInvitations.id,
        email: schema.teamInvitations.email,
        role: schema.teamInvitations.role,
        status: schema.teamInvitations.status,
        expiresAt: schema.teamInvitations.expiresAt,
        createdAt: schema.teamInvitations.createdAt,
      });

    if (!updated) {
      throw new TeamManagementError("team_invitation_revoke_failed", "초대를 철회하지 못했습니다.", 500);
    }
    return updated;
  });

  return toInvitationRecord(row, null, true);
}

export async function updateTeamMemberRole(input: {
  access: CompanyAccess;
  targetUserId: string;
  role: TeamManagedRole;
}): Promise<TeamMemberRoleUpdate> {
  assertTeamAdmin(input.access);
  const role = normalizeRole(input.role);
  const targetUserId = normalizeUuid(input.targetUserId, "userId");
  if (targetUserId === input.access.userId) {
    throw new TeamManagementError(
      "self_role_change_forbidden",
      "본인의 역할은 직접 변경할 수 없습니다.",
      403,
      "userId",
    );
  }
  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    throw new TeamManagementError(
      "team_member_update_unavailable",
      "현재 환경에서는 멤버 역할을 저장할 수 없습니다.",
      503,
    );
  }

  const db = getCunoteDb();
  return await withCunoteDbUser(db, input.access.userId, async (tx) => {
    const [existing] = await tx
      .select({
        userId: schema.userCompany.userId,
        role: schema.userCompany.role,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.userCompany)
      .leftJoin(schema.users, eq(schema.users.id, schema.userCompany.userId))
      .where(and(
        eq(schema.userCompany.companyId, input.access.companyId),
        eq(schema.userCompany.userId, targetUserId),
      ))
      .limit(1);

    if (!existing) {
      throw new TeamManagementError("team_member_not_found", "멤버를 찾지 못했습니다.", 404, "userId");
    }
    if (existing.role === "owner") {
      throw new TeamManagementError("owner_role_locked", "소유자 역할은 이 화면에서 변경할 수 없습니다.", 403, "role");
    }

    const previousRole = normalizeRole(existing.role);
    if (previousRole === role) {
      return { userId: existing.userId, role, roleChangeEvent: null };
    }

    const [actor] = await tx
      .select({
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.users)
      .where(eq(schema.users.id, input.access.userId))
      .limit(1);

    const [updated] = await tx
      .update(schema.userCompany)
      .set({ role })
      .where(and(
        eq(schema.userCompany.companyId, input.access.companyId),
        eq(schema.userCompany.userId, targetUserId),
      ))
      .returning({
        userId: schema.userCompany.userId,
        role: schema.userCompany.role,
      });

    if (!updated) {
      throw new TeamManagementError("team_member_update_failed", "멤버 역할을 저장하지 못했습니다.", 500);
    }

    const [roleEvent] = await tx
      .insert(schema.teamRoleChangeEvents)
      .values({
        companyId: input.access.companyId,
        targetUserId: existing.userId,
        actorUserId: input.access.userId,
        previousRole,
        nextRole: role,
        targetSnapshot: userSnapshot({
          userId: existing.userId,
          name: existing.name,
          email: existing.email,
        }),
        actorSnapshot: userSnapshot({
          userId: actor?.userId ?? input.access.userId,
          name: actor?.name ?? null,
          email: actor?.email ?? null,
        }),
        source: "team_management",
      })
      .returning({
        id: schema.teamRoleChangeEvents.id,
        companyId: schema.teamRoleChangeEvents.companyId,
        targetUserId: schema.teamRoleChangeEvents.targetUserId,
        actorUserId: schema.teamRoleChangeEvents.actorUserId,
        previousRole: schema.teamRoleChangeEvents.previousRole,
        nextRole: schema.teamRoleChangeEvents.nextRole,
        targetSnapshot: schema.teamRoleChangeEvents.targetSnapshot,
        actorSnapshot: schema.teamRoleChangeEvents.actorSnapshot,
        source: schema.teamRoleChangeEvents.source,
        createdAt: schema.teamRoleChangeEvents.createdAt,
      });

    return {
      userId: updated.userId,
      role: normalizeRole(updated.role),
      roleChangeEvent: roleEvent ? toRoleChangeEventRecord(roleEvent, true) : null,
    };
  });
}

export async function acceptTeamInvitation(input: {
  token: string;
  session: WebSession;
}): Promise<TeamInvitationAcceptance> {
  const token = input.token.trim();
  if (token.length < 20) {
    throw new TeamManagementError("invalid_invitation", "초대 링크를 확인해주세요.", 400, "token");
  }
  if (!hasDatabaseUrl()) {
    throw new TeamManagementError("invitation_accept_unavailable", "현재 환경에서는 초대를 수락할 수 없습니다.", 503);
  }

  const now = new Date();
  const db = getCunoteDb();
  const tokenHash = hashToken(token);
  return await withCunoteDbUser(db, input.session.user.id, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.tokenHash, tokenHash))
      .limit(1);
    if (!invitation) {
      throw new TeamManagementError("invitation_not_found", "초대 링크를 찾지 못했습니다.", 404, "token");
    }
    if (invitation.status !== "pending") {
      throw new TeamManagementError("invitation_not_pending", "이미 처리된 초대입니다.", 409, "token");
    }
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      await tx
        .update(schema.teamInvitations)
        .set({ status: "expired", updatedAt: now })
        .where(eq(schema.teamInvitations.id, invitation.id));
      throw new TeamManagementError("invitation_expired", "초대 링크가 만료되었습니다.", 410, "token");
    }
    if (input.session.user.email && normalizeEmail(input.session.user.email) !== normalizeEmail(invitation.email)) {
      throw new TeamManagementError("invitation_email_mismatch", "초대받은 이메일 계정으로 로그인해주세요.", 403, "email");
    }
    const role = normalizeRole(invitation.role);
    const [existingMembership] = await tx
      .select({ role: schema.userCompany.role })
      .from(schema.userCompany)
      .where(and(
        eq(schema.userCompany.companyId, invitation.companyId),
        eq(schema.userCompany.userId, input.session.user.id),
      ))
      .limit(1);
    if (!existingMembership) {
      await assertTeamSeatAvailable({
        tx,
        companyId: invitation.companyId,
        pendingSeatDelta: 0,
        now,
      });
      await tx
        .insert(schema.userCompany)
        .values({
          userId: input.session.user.id,
          companyId: invitation.companyId,
          role,
          invitedBy: invitation.invitedBy,
          createdAt: now,
        });
    }
    const [row] = await tx
      .update(schema.teamInvitations)
      .set({
        status: "accepted",
        acceptedBy: input.session.user.id,
        acceptedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.teamInvitations.id, invitation.id))
      .returning({
        companyId: schema.teamInvitations.companyId,
        role: schema.teamInvitations.role,
        acceptedAt: schema.teamInvitations.acceptedAt,
      });
    if (!row?.acceptedAt) {
      throw new TeamManagementError("invitation_accept_failed", "초대를 수락하지 못했습니다.", 500);
    }
    return {
      companyId: row.companyId,
      role: normalizeRole(row.role),
      acceptedAt: row.acceptedAt.toISOString(),
    };
  });
}

export function isTeamManagedRole(value: unknown): value is TeamManagedRole {
  return typeof value === "string" && MANAGED_ROLES.includes(value as TeamManagedRole);
}

export function resolveTeamSeatLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000) return EARLY_ACCESS_LIMITS.seats;
  return Math.floor(parsed);
}

function assertTeamAdmin(access: CompanyAccess) {
  if (!canManageTeam(access)) {
    throw new TeamManagementError("team_admin_required", "팀 권한을 관리할 수 있는 역할이 아닙니다.", 403);
  }
}

function canManageTeam(access: CompanyAccess): boolean {
  return access.role === "owner" || access.role === "admin";
}

function normalizeRole(value: CompanyRole): TeamManagedRole {
  if (!isTeamManagedRole(value)) {
    throw new TeamManagementError("invalid_team_role", "초대할 역할을 확인해주세요.", 400, "role");
  }
  return value;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamManagementError("invalid_email", "초대받을 이메일을 확인해주세요.", 400, "email");
  }
  return email.slice(0, 160);
}

function normalizeUuid(value: string, field: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  throw new TeamManagementError("invalid_uuid", "대상 식별자를 확인해주세요.", 400, field);
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildInviteUrl(origin: string, token: string): string {
  const safeOrigin = origin.replace(/\/$/, "");
  return `${safeOrigin}/team/invite/${encodeURIComponent(token)}`;
}

async function assertTeamSeatAvailable(input: {
  tx: CunoteDbSession;
  companyId: string;
  pendingSeatDelta: number;
  now: Date;
}) {
  const usage = await readTeamSeatUsage(input);
  if (usage.reservedSeats + input.pendingSeatDelta > usage.seatLimit) {
    throw new TeamManagementError(
      "team_seat_limit_exceeded",
      `현재 플랜의 팀 좌석 ${usage.seatLimit}석을 모두 사용했습니다.`,
      409,
      "seatLimit",
    );
  }
}

async function readTeamSeatUsage(input: {
  tx: CunoteDbSession;
  companyId: string;
  now: Date;
}): Promise<TeamSeatUsage> {
  const [memberCountRow] = await input.tx
    .select({ value: count() })
    .from(schema.userCompany)
    .where(eq(schema.userCompany.companyId, input.companyId));
  const [pendingInvitationCountRow] = await input.tx
    .select({ value: count() })
    .from(schema.teamInvitations)
    .where(and(
      eq(schema.teamInvitations.companyId, input.companyId),
      eq(schema.teamInvitations.status, "pending"),
      gt(schema.teamInvitations.expiresAt, input.now),
    ));
  const [subscriptionRow] = await input.tx
    .select({ seatLimit: schema.billingSubscriptions.seatLimit })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.companyId, input.companyId))
    .limit(1);
  const activeSeats = memberCountRow?.value ?? 0;
  const pendingInvitations = pendingInvitationCountRow?.value ?? 0;
  const reservedSeats = activeSeats + pendingInvitations;
  const seatLimit = resolveTeamSeatLimit(subscriptionRow?.seatLimit);

  return {
    activeSeats,
    pendingInvitations,
    reservedSeats,
    seatLimit,
    availableSeats: Math.max(0, seatLimit - reservedSeats),
  };
}

function effectiveInvitationStatus(
  status: TeamInvitationStatus,
  expiresAt: Date,
  now = new Date(),
): TeamInvitationStatus {
  if (status === "pending" && expiresAt.getTime() <= now.getTime()) return "expired";
  return status;
}

function fallbackInvitation(input: {
  email: string;
  role: TeamManagedRole;
  origin: string;
  now: Date;
  expiresAt: Date;
}): TeamInvitationRecord {
  return {
    id: `queued-${randomUUID()}`,
    email: input.email,
    role: input.role,
    status: "pending",
    expiresAt: input.expiresAt.toISOString(),
    createdAt: input.now.toISOString(),
    inviteUrl: null,
    persisted: false,
    emailDelivery: skippedEmailDelivery(),
  };
}

function userSnapshot(input: {
  userId: string;
  name: string | null;
  email: string | null;
}): Record<string, unknown> {
  return {
    userId: input.userId,
    name: input.name,
    email: input.email,
  };
}

function toRoleChangeEventRecord(
  row: {
    id: string;
    companyId: string;
    targetUserId: string | null;
    actorUserId: string | null;
    previousRole: CompanyRole;
    nextRole: CompanyRole;
    targetSnapshot: Record<string, unknown>;
    actorSnapshot: Record<string, unknown>;
    source: string;
    createdAt: Date;
  },
  persisted: boolean,
): TeamRoleChangeEventRecord {
  const targetName = snapshotString(row.targetSnapshot.name) ?? snapshotString(row.targetSnapshot.email) ?? "알 수 없는 멤버";
  const actorName = snapshotString(row.actorSnapshot.name) ?? snapshotString(row.actorSnapshot.email) ?? "알 수 없는 관리자";

  return {
    id: row.id,
    companyId: row.companyId,
    targetUserId: row.targetUserId,
    targetName,
    targetEmail: snapshotString(row.targetSnapshot.email),
    previousRole: row.previousRole,
    nextRole: row.nextRole,
    actorUserId: row.actorUserId,
    actorName,
    actorEmail: snapshotString(row.actorSnapshot.email),
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    persisted,
  };
}

function snapshotString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toInvitationRecord(
  row: {
    id: string;
    email: string;
    role: CompanyRole;
    status: TeamInvitationStatus;
    expiresAt: Date;
    createdAt: Date;
  },
  inviteUrl: string | null,
  persisted: boolean,
): TeamInvitationRecord {
  return {
    id: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    status: effectiveInvitationStatus(row.status, row.expiresAt),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    inviteUrl,
    persisted,
    emailDelivery: skippedEmailDelivery(),
  };
}

async function toInvitationRecordWithDelivery(input: {
  row: {
    id: string;
    email: string;
    role: CompanyRole;
    status: TeamInvitationStatus;
    expiresAt: Date;
    createdAt: Date;
  };
  inviteUrl: string;
  persisted: boolean;
  companyName?: string | null;
}): Promise<TeamInvitationRecord> {
  const record = toInvitationRecord(input.row, input.inviteUrl, input.persisted);
  return {
    ...record,
    emailDelivery: await deliverTeamInvitationEmail({
      record,
      companyName: input.companyName ?? "창업노트 워크스페이스",
    }),
  };
}

async function deliverTeamInvitationEmail(input: {
  record: TeamInvitationRecord;
  companyName: string;
}): Promise<OutboundEmailDeliveryResult> {
  if (!input.record.inviteUrl) return skippedEmailDelivery();
  const legal = getLegalConfig();
  try {
    return await sendOutboundEmail({
      message: {
        to: { email: input.record.email },
        from: { email: process.env.CUNOTE_EMAIL_FROM?.trim() || legal.supportEmail, name: "창업노트 팀" },
        replyTo: { email: process.env.CUNOTE_EMAIL_REPLY_TO?.trim() || legal.supportEmail },
        subject: teamInvitationEmailSubject(input.companyName),
        text: renderTeamInvitationEmailText({
          email: input.record.email,
          role: input.record.role,
          companyName: input.companyName,
          inviteUrl: input.record.inviteUrl,
          expiresAt: input.record.expiresAt,
        }),
        tags: [TEAM_INVITATION_EMAIL_TAG],
      },
    });
  } catch (error) {
    if (error instanceof Error && "result" in error) {
      const result = (error as { result?: OutboundEmailDeliveryResult }).result;
      if (result) return result;
    }
    return { ...getOutboundEmailProviderStatus(), status: "failed" };
  }
}

function skippedEmailDelivery(): OutboundEmailDeliveryResult {
  return { ...getOutboundEmailProviderStatus(), status: "skipped" };
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

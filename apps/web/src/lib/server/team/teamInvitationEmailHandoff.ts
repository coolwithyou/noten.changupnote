import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import type { TeamManagedRole } from "./teamManagement";

export const TEAM_INVITATION_EMAIL_TAG = "team_invitation";

export interface TeamInvitationEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export interface TeamInvitationEmailHandoffInput {
  email: string;
  role: TeamManagedRole;
  companyName: string;
  inviteUrl: string;
  expiresAt: string;
  generatedAt?: Date;
}

export class TeamInvitationEmailHandoffError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "TeamInvitationEmailHandoffError";
  }
}

export async function buildTeamInvitationEmailHandoff(input: {
  token: string;
  origin: string;
  asOf?: Date;
}): Promise<TeamInvitationEmailHandoff> {
  const token = normalizeToken(input.token);
  if (!hasDatabaseUrl()) {
    throw new TeamInvitationEmailHandoffError("team_invitation_storage_unavailable", "초대 저장소가 연결되지 않았습니다.", 503);
  }

  const db = getCunoteDb();
  const [row] = await db
    .select({
      id: schema.teamInvitations.id,
      email: schema.teamInvitations.email,
      role: schema.teamInvitations.role,
      status: schema.teamInvitations.status,
      expiresAt: schema.teamInvitations.expiresAt,
      companyName: schema.companies.name,
    })
    .from(schema.teamInvitations)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.teamInvitations.companyId))
    .where(eq(schema.teamInvitations.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) {
    throw new TeamInvitationEmailHandoffError("team_invitation_not_found", "초대 링크를 찾지 못했습니다.", 404, "token");
  }
  if (row.status !== "pending") {
    throw new TeamInvitationEmailHandoffError("team_invitation_not_pending", "이미 처리된 초대입니다.", 409, "token");
  }
  if (row.expiresAt.getTime() <= (input.asOf ?? new Date()).getTime()) {
    throw new TeamInvitationEmailHandoffError("team_invitation_expired", "초대 링크가 만료되었습니다.", 410, "token");
  }

  return renderTeamInvitationEmailHandoff({
    email: row.email,
    role: normalizeRole(row.role),
    companyName: row.companyName ?? "창업노트 워크스페이스",
    inviteUrl: buildInviteUrl(input.origin, token),
    expiresAt: row.expiresAt.toISOString(),
    generatedAt: input.asOf ?? new Date(),
  });
}

export function renderTeamInvitationEmailHandoff(
  input: TeamInvitationEmailHandoffInput,
): TeamInvitationEmailHandoff {
  const generatedAt = input.generatedAt ?? new Date();
  const filenameBase = sanitizeDownloadFilename(input.companyName, "워크스페이스");
  const eml = renderEml({
    from: teamFromAddress(),
    to: input.email,
    subject: teamInvitationEmailSubject(input.companyName),
    date: generatedAt,
    body: renderTeamInvitationEmailText(input),
  });

  return {
    filename: `창업노트-${filenameBase}-팀초대.eml`,
    fallbackFilename: "cunote-team-invitation.eml",
    eml,
  };
}

export function teamInvitationEmailHandoffDownloadResponse(
  handoff: TeamInvitationEmailHandoff,
): Response {
  return textDownloadResponse({
    body: handoff.eml,
    filename: handoff.filename,
    fallbackFilename: handoff.fallbackFilename,
    contentType: "message/rfc822; charset=utf-8",
  });
}

export function teamInvitationEmailSubject(companyName: string): string {
  return `${companyName} 창업노트 초대`;
}

export function renderTeamInvitationEmailText(input: TeamInvitationEmailHandoffInput): string {
  return [
    "안녕하세요.",
    "",
    `${input.companyName} 워크스페이스에 ${roleLabel(input.role)} 역할로 초대되었습니다.`,
    "",
    "아래 링크로 로그인한 뒤 초대를 수락해주세요.",
    input.inviteUrl,
    "",
    `초대 만료: ${formatDateTime(new Date(input.expiresAt))}`,
    "",
    "본인이 요청하지 않은 초대라면 이 메일을 무시해도 됩니다.",
    "",
    "-- ",
    "창업노트 팀",
    "",
  ].join("\n");
}

function renderEml(input: {
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: <${input.to.trim()}>`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: team-invitation-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (token.length < 20) {
    throw new TeamInvitationEmailHandoffError("invalid_team_invitation_token", "초대 링크를 확인해주세요.", 400, "token");
  }
  return token;
}

function normalizeRole(value: string): TeamManagedRole {
  if (value === "admin" || value === "member" || value === "viewer") return value;
  return "viewer";
}

function roleLabel(role: TeamManagedRole): string {
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}

function teamFromAddress(): string {
  const email = process.env.CUNOTE_SUPPORT_EMAIL?.trim() || "support@changupnote.com";
  return `=?UTF-8?B?${Buffer.from("창업노트 팀", "utf8").toString("base64")}?= <${email}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/team/invite/${encodeURIComponent(token)}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

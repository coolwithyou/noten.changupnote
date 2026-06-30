import { desc, eq } from "drizzle-orm";
import type { CompanyRole } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { loadBillingSubscriptionSnapshot, type BillingSubscriptionSnapshot } from "@/lib/server/billing/subscription";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { getServiceRepositories, loadServiceDashboard } from "@/lib/server/serviceData";
import {
  listTeamInvitations,
  listTeamRoleChangeEvents,
  type TeamInvitationRecord,
  type TeamRoleChangeEventRecord,
} from "@/lib/server/team/teamManagement";
import { EARLY_ACCESS_LIMITS } from "./limits";

export interface WorkspaceCompany {
  id: string;
  name: string;
  role: CompanyRole;
  verified: boolean;
  bizNoMasked: string | null;
  region: string | null;
  kind: "active" | "preliminary";
}

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string | null;
  role: CompanyRole;
  joinedAt: string | null;
  currentUser: boolean;
}

export interface WorkspaceUsageMetric {
  label: string;
  value: number;
  limit: number | null;
  unit: string;
  tone: "brand" | "success" | "warning" | "neutral";
  description: string;
}

export interface WorkspacePlanOverview {
  planName: string;
  status: string;
  priceLabel: string;
  renewalLabel: string;
  included: string[];
  nextSteps: string[];
}

export interface WorkspaceSeatUsage {
  activeSeats: number;
  pendingInvitations: number;
  reservedSeats: number;
  seatLimit: number;
  availableSeats: number;
  limitReached: boolean;
}

export interface WorkspaceOverview {
  generatedAt: string;
  currentCompany: WorkspaceCompany;
  companies: WorkspaceCompany[];
  members: WorkspaceMember[];
  invitations: TeamInvitationRecord[];
  roleChangeEvents: TeamRoleChangeEventRecord[];
  seatUsage: WorkspaceSeatUsage;
  usage: WorkspaceUsageMetric[];
  plan: WorkspacePlanOverview;
  billingSubscription: BillingSubscriptionSnapshot;
}

export async function loadWorkspaceOverview(input: {
  access: CompanyAccess;
  session: WebSession | null;
}): Promise<WorkspaceOverview> {
  const [companies, dashboard, draftStats, members, invitations, roleChangeEvents, billingSubscription] = await Promise.all([
    loadCompanies(input.access),
    loadServiceDashboard({
      companyId: input.access.companyId,
      userId: input.access.userId,
      limit: EARLY_ACCESS_LIMITS.activeOpportunities,
      writeMatchStates: false,
    }),
    loadDraftStats(input.access),
    loadWorkspaceMembers(input.access, input.session),
    listTeamInvitations({ access: input.access }),
    listTeamRoleChangeEvents({ access: input.access, limit: 12 }),
    loadBillingSubscriptionSnapshot({ access: input.access }),
  ]);
  const currentCompany = companies.find((company) => company.id === input.access.companyId) ?? fallbackCompany(input.access);
  const activeOpportunityCount = dashboard.counts.eligible + dashboard.counts.conditional;
  const seatUsage = buildWorkspaceSeatUsage(members, invitations, new Date(), billingSubscription.seatLimit);

  return {
    generatedAt: new Date().toISOString(),
    currentCompany,
    companies,
    members,
    invitations,
    roleChangeEvents,
    seatUsage,
    billingSubscription,
    plan: {
      planName: billingSubscription.planName,
      status: billingSubscription.statusLabel,
      priceLabel: billingSubscription.priceLabel,
      renewalLabel: billingSubscription.renewalLabel,
      included: billingSubscription.included,
      nextSteps: billingSubscription.nextSteps,
    },
    usage: [
      {
        label: "회사",
        value: companies.length,
        limit: EARLY_ACCESS_LIMITS.companies,
        unit: "개",
        tone: companies.length >= EARLY_ACCESS_LIMITS.companies ? "warning" : "brand",
        description: "현재 계정에서 접근 가능한 회사 수",
      },
      {
        label: "팀 좌석",
        value: seatUsage.reservedSeats,
        limit: seatUsage.seatLimit,
        unit: "명",
        tone: seatUsage.limitReached ? "warning" : "brand",
        description: `멤버 ${seatUsage.activeSeats}명 · 대기 ${seatUsage.pendingInvitations}명`,
      },
      {
        label: "AI 초안",
        value: draftStats.total,
        limit: EARLY_ACCESS_LIMITS.drafts,
        unit: "개",
        tone: draftStats.exported > 0 ? "success" : "brand",
        description: `검토 ${draftStats.reviewed}개 · 내보냄 ${draftStats.exported}개`,
      },
      {
        label: "활성 기회",
        value: activeOpportunityCount,
        limit: null,
        unit: "건",
        tone: activeOpportunityCount > 0 ? "success" : "neutral",
        description: "적격과 조건부 확인 공고 합계",
      },
    ],
  };
}

function buildWorkspaceSeatUsage(
  members: WorkspaceMember[],
  invitations: TeamInvitationRecord[],
  now: Date,
  seatLimit: number,
): WorkspaceSeatUsage {
  const pendingInvitations = invitations.filter((invitation) =>
    invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > now.getTime()
  ).length;
  const activeSeats = members.length;
  const reservedSeats = activeSeats + pendingInvitations;
  const availableSeats = Math.max(0, seatLimit - reservedSeats);

  return {
    activeSeats,
    pendingInvitations,
    reservedSeats,
    seatLimit,
    availableSeats,
    limitReached: availableSeats <= 0,
  };
}

async function loadCompanies(access: CompanyAccess): Promise<WorkspaceCompany[]> {
  try {
    const companies = await getServiceRepositories().companies.listUserCompanies(access.userId);
    return companies.map((company) => ({
      id: company.id,
      name: company.name ?? company.profile.name ?? "이름 없는 회사",
      role: company.role ?? "viewer",
      verified: company.verified ?? false,
      bizNoMasked: company.bizNoMasked ?? null,
      region: company.profile.region?.label ?? null,
      kind: company.profile.is_preliminary ? "preliminary" : "active",
    }));
  } catch {
    return [fallbackCompany(access)];
  }
}

async function loadWorkspaceMembers(
  access: CompanyAccess,
  session: WebSession | null,
): Promise<WorkspaceMember[]> {
  if (access.mode === "demo" || !hasDatabaseUrl()) {
    return [fallbackMember(access, session)];
  }

  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
      .select({
        userId: schema.userCompany.userId,
        role: schema.userCompany.role,
        joinedAt: schema.userCompany.createdAt,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.userCompany)
      .innerJoin(schema.users, eq(schema.users.id, schema.userCompany.userId))
      .where(eq(schema.userCompany.companyId, access.companyId))
      .orderBy(desc(schema.userCompany.createdAt)));
    if (rows.length === 0) return [fallbackMember(access, session)];
    return rows.map((row) => ({
      userId: row.userId,
      name: row.name ?? row.email,
      email: row.email,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
      currentUser: row.userId === access.userId,
    }));
  } catch {
    return [fallbackMember(access, session)];
  }
}

async function loadDraftStats(access: CompanyAccess): Promise<{
  total: number;
  reviewed: number;
  exported: number;
}> {
  if (!hasDatabaseUrl()) return { total: 0, reviewed: 0, exported: 0 };
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
      .select({ status: schema.grantDocumentDrafts.status })
      .from(schema.grantDocumentDrafts)
      .where(eq(schema.grantDocumentDrafts.companyId, access.companyId)));
    return {
      total: rows.length,
      reviewed: rows.filter((row) => row.status === "reviewed").length,
      exported: rows.filter((row) => row.status === "exported").length,
    };
  } catch {
    return { total: 0, reviewed: 0, exported: 0 };
  }
}

function fallbackCompany(access: CompanyAccess): WorkspaceCompany {
  return {
    id: access.companyId,
    name: "현재 회사",
    role: access.role,
    verified: false,
    bizNoMasked: null,
    region: null,
    kind: "preliminary",
  };
}

function fallbackMember(access: CompanyAccess, session: WebSession | null): WorkspaceMember {
  const email = session?.user.email ?? null;
  return {
    userId: access.userId,
    name: session?.user.name ?? email ?? "현재 사용자",
    email,
    role: access.role,
    joinedAt: null,
    currentUser: true,
  };
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

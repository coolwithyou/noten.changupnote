import type { ConsentRecordDto, NotificationSettingsDto } from "@cunote/contracts";
import { eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { getConsentStore } from "@/lib/server/consents/consentStore";
import { getCunoteDb } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";
import {
  listBillingPlanRequestHistory,
  type BillingPlanRequestHistoryItem,
} from "@/lib/server/billing/planRequestHistory";
import {
  listBillingInvoices,
  type BillingInvoiceItem,
} from "@/lib/server/billing/invoices";
import {
  listBillingPaymentMethods,
  type BillingPaymentMethodItem,
} from "@/lib/server/billing/paymentMethods";
import {
  loadBillingTaxProfile,
  type BillingTaxProfileItem,
} from "@/lib/server/billing/taxProfile";
import {
  listBillingTaxDocuments,
  type BillingTaxDocumentItem,
} from "@/lib/server/billing/taxDocuments";
import type { BillingSubscriptionSnapshot } from "@/lib/server/billing/subscription";
import { sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import { loadNotificationCenter } from "@/lib/server/notifications/notificationCenter";
import { listAccountSupportTickets, type AccountSupportTicketItem } from "@/lib/server/support/supportTicketMessages";
import { loadWorkspaceOverview, type WorkspaceOverview } from "@/lib/server/workspace/overview";
import type { NotificationCenterResult } from "@/lib/notifications/types";
import {
  listAccountDeletionRequestHistory,
  type AccountDeletionRequestHistoryItem,
} from "./accountDeletionRequestHistory";

export interface AccountDataExport {
  schema: "cunote.account_export.v1";
  generatedAt: string;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    provider: WebSession["provider"] | "none";
  };
  access: {
    companyId: string;
    role: string;
    mode: CompanyAccess["mode"];
  };
  workspace: WorkspaceOverview;
  consents: ConsentRecordDto[];
  notificationSettings: NotificationSettingsDto;
  notificationCenter: NotificationCenterResult;
  supportTickets: AccountSupportTicketItem[];
  billingSubscription: BillingSubscriptionSnapshot;
  billingTaxProfile: BillingTaxProfileItem;
  billingTaxDocuments: BillingTaxDocumentItem[];
  billingInvoices: BillingInvoiceItem[];
  billingPaymentMethods: BillingPaymentMethodItem[];
  billingPlanRequests: BillingPlanRequestHistoryItem[];
  deletionRequests: AccountDeletionRequestHistoryItem[];
  legal: {
    serviceName: string;
    operatorName: string;
    supportEmail: string;
    privacyEmail: string;
    termsVersion: string;
    privacyVersion: string;
    effectiveDate: string;
    privacyOfficerName: string;
    businessRegistrationNumber: string | null;
    businessAddress: string | null;
    mailOrderRegistrationNumber: string | null;
    retentionSummary: string;
    privacyProcessors: Array<{
      name: string;
      purpose: string;
      country: string | null;
      retention: string | null;
    }>;
    overseasTransfers: Array<{
      recipient: string;
      country: string;
      purpose: string;
      transferredItems: string;
      retention: string | null;
      contact: string | null;
    }>;
    acceptance: {
      termsAcceptedAt: string | null;
      privacyAcceptedAt: string | null;
      termsVersion: string | null;
      privacyVersion: string | null;
    };
  };
  exclusions: string[];
}

export interface AccountDataExportDownload {
  filename: string;
  fallbackFilename: string;
  json: string;
}

export async function buildAccountDataExport(input: {
  access: CompanyAccess;
  session: WebSession | null;
}): Promise<AccountDataExportDownload> {
  const generatedAt = new Date().toISOString();
  const [
    workspace,
    consents,
    notificationSettings,
    notificationCenter,
    supportTickets,
    billingTaxProfile,
    billingTaxDocuments,
    billingInvoices,
    billingPaymentMethods,
    billingPlanRequests,
    deletionRequests,
    userProfile,
    legalAcceptance,
  ] = await Promise.all([
    loadWorkspaceOverview(input),
    getConsentStore().listCompanyConsents(input.access.companyId, input.access.userId),
    getAppPreferencesStore().getNotificationSettings(input.access.userId),
    loadNotificationCenter({ access: input.access, limit: 40 }),
    listAccountSupportTickets({ access: input.access, session: input.session, limit: 20 }),
    loadBillingTaxProfile({ access: input.access, session: input.session }),
    listBillingTaxDocuments({ access: input.access, limit: 20 }),
    listBillingInvoices({ access: input.access, limit: 20 }),
    listBillingPaymentMethods({ access: input.access, limit: 20 }),
    listBillingPlanRequestHistory({ access: input.access, session: input.session, limit: 10 }),
    listAccountDeletionRequestHistory({ access: input.access, session: input.session, limit: 10 }),
    loadUserExportProfile(input.access.userId),
    loadUserLegalAcceptance(input.access.userId),
  ]);
  const legal = getLegalConfig();
  const exportData: AccountDataExport = {
    schema: "cunote.account_export.v1",
    generatedAt,
    user: {
      id: userProfile.id ?? input.session?.user.id ?? input.access.userId,
      email: userProfile.email ?? input.session?.user.email ?? null,
      name: userProfile.name ?? input.session?.user.name ?? null,
      provider: input.session?.provider ?? "none",
    },
    access: {
      companyId: input.access.companyId,
      role: input.access.role,
      mode: input.access.mode,
    },
    workspace,
    consents,
    notificationSettings,
    notificationCenter,
    supportTickets,
    billingSubscription: workspace.billingSubscription,
    billingTaxProfile,
    billingTaxDocuments,
    billingInvoices,
    billingPaymentMethods,
    billingPlanRequests,
    deletionRequests,
    legal: {
      serviceName: legal.serviceName,
      operatorName: legal.operatorName,
      supportEmail: legal.supportEmail,
      privacyEmail: legal.privacyEmail,
      termsVersion: legal.termsVersion,
      privacyVersion: legal.privacyVersion,
      effectiveDate: legal.effectiveDate,
      privacyOfficerName: legal.privacyOfficerName,
      businessRegistrationNumber: legal.businessRegistrationNumber,
      businessAddress: legal.businessAddress,
      mailOrderRegistrationNumber: legal.mailOrderRegistrationNumber,
      retentionSummary: legal.retentionSummary,
      privacyProcessors: legal.privacyProcessors,
      overseasTransfers: legal.overseasTransfers,
      acceptance: legalAcceptance,
    },
    exclusions: [
      "비밀번호 hash, OAuth access/refresh token, 앱 push token, 세션 token은 export에 포함하지 않습니다.",
      "다른 회사 멤버의 개인정보와 내부 관리자 메모는 현재 사용자 권한 범위 밖이면 포함하지 않습니다.",
      "원문 첨부 파일 본문은 포함하지 않고, 공고 상세와 신청 패키지 export에서 접근 가능한 링크로 분리합니다.",
    ],
  };
  const filenameBase = sanitizeDownloadFilename(
    userProfile.email ?? input.session?.user.email ?? userProfile.name ?? input.session?.user.name ?? input.access.companyId,
    "account",
  );

  return {
    filename: `창업노트-${filenameBase}-계정데이터.json`,
    fallbackFilename: `cunote-account-export-${stableId(input.access.companyId)}.json`,
    json: `${JSON.stringify(exportData, null, 2)}\n`,
  };
}

function stableId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "account";
}

async function loadUserExportProfile(userId: string): Promise<{ id: string | null; email: string | null; name: string | null }> {
  try {
    const [row] = await getCunoteDb()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return {
      id: row?.id ?? null,
      email: row?.email ?? null,
      name: row?.name ?? null,
    };
  } catch {
    return {
      id: null,
      email: null,
      name: null,
    };
  }
}

async function loadUserLegalAcceptance(userId: string): Promise<AccountDataExport["legal"]["acceptance"]> {
  try {
    const [row] = await getCunoteDb()
      .select({
        termsAcceptedAt: users.termsAcceptedAt,
        privacyAcceptedAt: users.privacyAcceptedAt,
        termsVersion: users.termsVersion,
        privacyVersion: users.privacyVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return {
      termsAcceptedAt: row?.termsAcceptedAt?.toISOString() ?? null,
      privacyAcceptedAt: row?.privacyAcceptedAt?.toISOString() ?? null,
      termsVersion: row?.termsVersion ?? null,
      privacyVersion: row?.privacyVersion ?? null,
    };
  } catch {
    return {
      termsAcceptedAt: null,
      privacyAcceptedAt: null,
      termsVersion: null,
      privacyVersion: null,
    };
  }
}

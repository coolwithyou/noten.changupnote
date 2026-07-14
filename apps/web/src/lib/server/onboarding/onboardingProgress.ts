import type { CompanyProfile, ConsentRecordDto, ConsentScope, NotificationSettingsDto } from "@cunote/contracts";
import type { CompanyRecord } from "@cunote/core";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { getConsentStore } from "@/lib/server/consents/consentStore";
import { getServiceRepositories, resolveProductCompanyProfile } from "@/lib/server/serviceData";

export type OnboardingStepKey = "company" | "consents" | "disqualification" | "profile" | "notifications";
export type OnboardingStepStatus = "complete" | "attention" | "pending";

export interface OnboardingProgressStep {
  key: OnboardingStepKey;
  title: string;
  description: string;
  status: OnboardingStepStatus;
  badge: string;
  detail: string;
  actionHref: string;
  actionLabel: string;
}

export interface OnboardingProgress {
  generatedAt: string;
  completedCount: number;
  totalCount: number;
  completionRatio: number;
  companyName: string;
  summary: string;
  nextStep: OnboardingProgressStep | null;
  steps: OnboardingProgressStep[];
}

const REQUIRED_CONSENT_SCOPES: ConsentScope[] = ["basic_info", "hometax", "insurance"];

// 결격 3축 — 각 축 답변 여부는 confidence 기록으로 판정(문항 응답 시 자가신고 confidence 기록).
const DISQUALIFICATION_AXES = ["tax_compliance", "credit_status", "sanction"] as const;

export async function loadOnboardingProgress(input: {
  access: CompanyAccess;
}): Promise<OnboardingProgress> {
  const [companyResult, consentsResult, notificationsResult] = await Promise.allSettled([
    loadCurrentCompany(input.access),
    getConsentStore().listCompanyConsents(input.access.companyId, input.access.userId),
    getAppPreferencesStore().getNotificationSettings(input.access.userId),
  ]);

  const company = companyResult.status === "fulfilled" ? companyResult.value : null;
  const profile = company?.profile ?? {};
  const consents = consentsResult.status === "fulfilled" ? consentsResult.value : [];
  const notifications = notificationsResult.status === "fulfilled" ? notificationsResult.value : defaultNotifications();
  const steps = buildSteps({ access: input.access, company, profile, consents, notifications });
  const completedCount = steps.filter((step) => step.status === "complete").length;
  const totalCount = steps.length;
  const nextStep = steps.find((step) => step.status !== "complete") ?? null;

  return {
    generatedAt: new Date().toISOString(),
    completedCount,
    totalCount,
    completionRatio: Math.round((completedCount / totalCount) * 100),
    companyName: company?.name ?? profile.name ?? "현재 회사",
    summary: onboardingSummary(nextStep),
    nextStep,
    steps,
  };
}

async function loadCurrentCompany(access: CompanyAccess): Promise<CompanyRecord | null> {
  const repositories = getServiceRepositories();
  try {
    const companies = await repositories.companies.listUserCompanies(access.userId);
    const company = companies.find((entry) => entry.id === access.companyId) ?? companies[0] ?? null;
    if (!company) return null;
    const resolution = await resolveProductCompanyProfile({
      context: "owned_read",
      companyId: company.id,
      userId: access.userId,
      asOf: new Date().toISOString(),
    });
    return { ...company, name: company.name ?? resolution.profile.name ?? null, profile: resolution.profile };
  } catch {
    try {
      const resolution = await resolveProductCompanyProfile({
        context: "owned_read",
        companyId: access.companyId,
        userId: access.userId,
        asOf: new Date().toISOString(),
      });
      return {
        id: access.companyId,
        name: resolution.profile.name ?? null,
        profile: resolution.profile,
        role: access.role,
        verified: false,
        verifiedAt: null,
        verifyMethod: null,
        bizNoMasked: null,
      };
    } catch {
      return null;
    }
  }
}

function buildSteps(input: {
  access: CompanyAccess;
  company: CompanyRecord | null;
  profile: CompanyProfile;
  consents: ConsentRecordDto[];
  notifications: NotificationSettingsDto;
}): OnboardingProgressStep[] {
  const consentCount = activeConsentCount(input.consents);
  const profileSignals = countProfileSignals(input.profile);
  const companyStatus = companyStepStatus(input.company, input.profile);
  const consentStatus = consentCount === REQUIRED_CONSENT_SCOPES.length
    ? "complete"
    : consentCount > 0 ? "attention" : "pending";
  const disqualificationAnswered = countDisqualificationAnswers(input.profile);
  const disqualificationStatus: OnboardingStepStatus = disqualificationAnswered === DISQUALIFICATION_AXES.length
    ? "complete"
    : disqualificationAnswered > 0 ? "attention" : "pending";
  const profileStatus = profileSignals.manual >= 2
    ? "complete"
    : profileSignals.total > 0 ? "attention" : "pending";
  const notificationsEnabled = input.notifications.deadlineReminder || input.notifications.newMatch;

  return [
    {
      key: "company",
      title: "회사 확인",
      description: "사업자번호와 대표자 정보로 회사 소유권을 확인합니다.",
      status: companyStatus,
      badge: statusBadge(companyStatus),
      detail: companyDetail(input.company, input.profile, input.access.mode),
      actionHref: "#company-settings",
      actionLabel: companyStatus === "complete" ? "검증 상태 보기" : "회사 검증하기",
    },
    {
      key: "consents",
      title: "정보 동의",
      description: "매칭과 신청 준비에 필요한 데이터 연결 범위를 선택합니다.",
      status: consentStatus,
      badge: statusBadge(consentStatus),
      detail: `${consentCount}/${REQUIRED_CONSENT_SCOPES.length}개 동의가 활성화되어 있습니다.`,
      actionHref: "#company-settings",
      actionLabel: consentStatus === "complete" ? "동의 상태 보기" : "동의 활성화",
    },
    {
      key: "disqualification",
      title: "결격 빠른 확인",
      description: "체납·신용·제재 등 결격 사유가 없는지 1분 만에 확인해 추천 결과를 확정합니다.",
      status: disqualificationStatus,
      badge: statusBadge(disqualificationStatus),
      detail: disqualificationDetail(disqualificationAnswered),
      actionHref: "#company-settings",
      actionLabel: disqualificationStatus === "complete" ? "결격 답변 확인" : "결격 여부 확인",
    },
    {
      key: "profile",
      title: "자가신고 보강",
      description: "매출, 고용, 인증, 기수혜 이력을 입력해 추천 정확도를 높입니다.",
      status: profileStatus,
      badge: statusBadge(profileStatus),
      detail: `수기 항목 ${profileSignals.manual}개 · 기본 속성 ${profileSignals.baseline}개가 준비되어 있습니다.`,
      actionHref: "#company-settings",
      actionLabel: profileStatus === "complete" ? "프로필 확인" : "수기 정보 저장",
    },
    {
      key: "notifications",
      title: "알림 설정",
      description: "마감 임박과 새 기회를 놓치지 않도록 수신 상태를 정합니다.",
      status: notificationsEnabled ? "complete" : "pending",
      badge: notificationsEnabled ? "완료" : "대기",
      detail: notificationDetail(input.notifications),
      actionHref: "#company-settings",
      actionLabel: notificationsEnabled ? "알림 상태 보기" : "알림 켜기",
    },
  ];
}

function companyStepStatus(
  company: CompanyRecord | null,
  profile: CompanyProfile,
): OnboardingStepStatus {
  if (company?.verified) return "complete";
  if (company || profile.name || profile.business_status?.active || profile.region || profile.industries?.length) {
    return "attention";
  }
  return "pending";
}

function companyDetail(
  company: CompanyRecord | null,
  profile: CompanyProfile,
  mode: CompanyAccess["mode"],
): string {
  if (company?.verified) {
    return company.bizNoMasked ? `소유권 검증 완료 · ${company.bizNoMasked}` : "회사 소유권 검증이 완료되어 있습니다.";
  }
  if (company?.bizNoMasked) {
    return `사업자번호 ${company.bizNoMasked} 연결됨 · 대표자 검증이 필요합니다.`;
  }
  if (profile.business_status?.active) return "사업자 상태는 정상으로 확인됐고, 소유권 검증만 남았습니다.";
  if (mode === "demo") return "데모 회사로 연결되어 있으며, 운영 환경에서는 사업자 검증이 필요합니다.";
  return "사업자번호, 대표자명, 개업일을 입력해 소유권을 검증하세요.";
}

function countDisqualificationAnswers(profile: CompanyProfile): number {
  // 각 축은 문항 응답 시 프로필 값 + confidence가 기록된다(자가신고). 값 존재로 답변 완료 판정.
  return DISQUALIFICATION_AXES.filter((axis) => profile[axis] !== undefined).length;
}

function disqualificationDetail(answered: number): string {
  if (answered === DISQUALIFICATION_AXES.length) {
    return "세금·신용·제재 결격 확인이 완료되어 결격 관련 추천이 확정됩니다.";
  }
  if (answered > 0) {
    return `${answered}/${DISQUALIFICATION_AXES.length}개 결격 항목이 확인되어 있습니다. 나머지도 확인해 주세요.`;
  }
  return "체납·신용·제재 결격 여부를 확인하면 '확인 필요'로 묶인 사업이 즉시 판정됩니다.";
}

function activeConsentCount(consents: ConsentRecordDto[]): number {
  const activeScopes = new Set(
    consents
      .filter((consent) => consent.revokedAt === null)
      .map((consent) => consent.scope),
  );
  return REQUIRED_CONSENT_SCOPES.filter((scope) => activeScopes.has(scope)).length;
}

function countProfileSignals(profile: CompanyProfile): {
  baseline: number;
  manual: number;
  total: number;
} {
  const baselineChecks = [
    Boolean(profile.region),
    Boolean(profile.industries?.length),
    typeof profile.biz_age_months === "number",
    typeof profile.founder_age === "number",
    Boolean(profile.size),
  ];
  const manualChecks = [
    typeof profile.revenue_krw === "number",
    typeof profile.employees_count === "number",
    Boolean(profile.target_types?.length),
    Boolean(profile.certs?.length),
    Boolean(profile.ip?.length),
    Array.isArray(profile.prior_awards),
  ];
  const baseline = baselineChecks.filter(Boolean).length;
  const manual = manualChecks.filter(Boolean).length;
  return { baseline, manual, total: baseline + manual };
}

function notificationDetail(settings: NotificationSettingsDto): string {
  const labels = [
    settings.deadlineReminder ? "마감 알림 켬" : "마감 알림 끔",
    settings.newMatch ? "새 매칭 켬" : "새 매칭 끔",
  ];
  if (settings.quietHoursStart && settings.quietHoursEnd) {
    labels.push(`${settings.quietHoursStart}-${settings.quietHoursEnd} 방해금지`);
  }
  return labels.join(" · ");
}

function statusBadge(status: OnboardingStepStatus): string {
  if (status === "complete") return "완료";
  if (status === "attention") return "확인 필요";
  return "대기";
}

function onboardingSummary(nextStep: OnboardingProgressStep | null): string {
  if (!nextStep) return "필수 온보딩이 완료되어 기회 맵과 신청 준비를 바로 진행할 수 있습니다.";
  return `${nextStep.title}${objectParticle(nextStep.title)} 먼저 보강하면 추천과 신청 준비 정확도가 올라갑니다.`;
}

function objectParticle(value: string): "을" | "를" {
  const last = [...value].at(-1);
  if (!last) return "를";
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return "를";
  return (code - 0xac00) % 28 === 0 ? "를" : "을";
}

function defaultNotifications(): NotificationSettingsDto {
  return {
    deadlineReminder: true,
    newMatch: true,
    quietHoursStart: null,
    quietHoursEnd: null,
  };
}

import assert from "node:assert/strict";
import type { OnboardingProgress } from "@/lib/server/onboarding/onboardingProgress";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";
import { buildSettingsReport, renderSettingsReport } from "./settingsReport";

const progress: OnboardingProgress = {
  generatedAt: "2026-06-30T00:00:00.000Z",
  completedCount: 2,
  totalCount: 4,
  completionRatio: 50,
  companyName: "검증 주식회사",
  summary: "정보 동의를 먼저 보강하면 추천과 신청 준비 정확도가 올라갑니다.",
  nextStep: null,
  steps: [
    {
      key: "company",
      title: "회사 확인",
      description: "사업자번호와 대표자 정보로 회사 소유권을 확인합니다.",
      status: "complete",
      badge: "완료",
      detail: "회사 소유권 검증이 완료되어 있습니다.",
      actionHref: "#company-settings",
      actionLabel: "검증 상태 보기",
    },
    {
      key: "consents",
      title: "정보 동의",
      description: "매칭과 신청 준비에 필요한 데이터 연결 범위를 선택합니다.",
      status: "attention",
      badge: "확인 필요",
      detail: "1/3개 동의가 활성화되어 있습니다.",
      actionHref: "#company-settings",
      actionLabel: "동의 활성화",
    },
  ],
};

const overview: WorkspaceOverview = {
  generatedAt: "2026-06-30T00:00:00.000Z",
  currentCompany: {
    id: "00000000-0000-4000-8000-000000000101",
    name: "검증 주식회사",
    role: "owner",
    verified: true,
    bizNoMasked: "123-**-67***",
    region: "서울",
    kind: "active",
  },
  companies: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      name: "검증 주식회사",
      role: "owner",
      verified: true,
      bizNoMasked: "123-**-67***",
      region: "서울",
      kind: "active",
    },
  ],
  members: [],
  invitations: [],
  roleChangeEvents: [],
  seatUsage: {
    activeSeats: 2,
    pendingInvitations: 1,
    reservedSeats: 3,
    seatLimit: 3,
    availableSeats: 0,
    limitReached: true,
  },
  usage: [
    {
      label: "팀 좌석",
      value: 3,
      limit: 3,
      unit: "명",
      tone: "warning",
      description: "멤버 2명 · 대기 1명",
    },
  ],
  plan: {
    planName: "Team",
    status: "검토중",
    priceLabel: "상담 후 확정",
    renewalLabel: "운영팀 확인",
    included: [],
    nextSteps: [],
  },
  billingSubscription: {
    source: "database",
    sourceLabel: "저장됨",
    persisted: true,
    provider: "manual",
    providerLabel: "수동",
    providerConfigured: false,
    status: "manual_review",
    statusLabel: "검토중",
    planCode: "team",
    planName: "Team",
    priceLabel: "상담 후 확정",
    renewalLabel: "운영팀 확인",
    seatLimit: 3,
    included: [],
    nextSteps: [],
    paymentMethodLabel: "미연동",
    invoiceStatusLabel: "미연동",
    providerPortalUrl: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    updatedAt: "2026-06-30T00:00:00.000Z",
    automation: {
      autoBillingEnabled: false,
      invoicesEnabled: false,
      paymentMethodManaged: false,
    },
  },
};

const generatedAt = new Date("2026-06-30T00:00:00.000Z");
const markdown = renderSettingsReport({ progress, overview, generatedAt });
const report = buildSettingsReport({ progress, overview, generatedAt });

assert(markdown.includes("# 검증 주식회사 설정 리포트"));
assert(markdown.includes("## 요약"));
assert(markdown.includes("| 온보딩 완료도 | 2/4 · 50% |"));
assert(markdown.includes("## 온보딩 단계"));
assert(markdown.includes("정보 동의"));
assert(markdown.includes("## 접근 가능한 회사"));
assert(markdown.includes("## 워크스페이스 사용량"));
assert(markdown.includes("좌석 한도에 도달"));
assert.equal(report.fallbackFilename, "cunote-settings-report-2026-06-30.md");
assert(report.filename.includes("창업노트-검증 주식회사-설정리포트-2026-06-30.md"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "settings_report_heading",
    "settings_report_summary",
    "settings_report_onboarding_steps",
    "settings_report_company_list",
    "settings_report_usage",
    "settings_report_next_actions",
    "settings_report_filename",
  ],
}, null, 2));

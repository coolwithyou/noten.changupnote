import assert from "node:assert/strict";
import type { BillingSubscriptionSnapshot } from "./subscription";
import type { BillingTaxProfileItem } from "./taxProfile";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";
import { renderBillingPaymentInstructions } from "./paymentInstructions";

process.env.CUNOTE_BILLING_PAYMENT_INSTRUCTIONS = "운영팀이 발행한 결제 링크 또는 세금계산서로 진행합니다.";

const subscription: BillingSubscriptionSnapshot = {
  source: "environment",
  sourceLabel: "환경 설정",
  persisted: false,
  provider: "manual",
  providerLabel: "수동",
  providerConfigured: false,
  status: "manual_review",
  statusLabel: "수동 검토",
  planCode: "team",
  planName: "Team",
  priceLabel: "월 99,000원",
  renewalLabel: "매월",
  seatLimit: 7,
  included: ["지원사업 매칭", "AI 초안"],
  nextSteps: ["운영팀 상담"],
  paymentMethodLabel: "결제수단 미등록",
  invoiceStatusLabel: "운영팀 확인",
  providerPortalUrl: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  updatedAt: null,
  automation: {
    autoBillingEnabled: false,
    invoicesEnabled: false,
    paymentMethodManaged: false,
  },
};

const overview = {
  currentCompany: {
    id: "company-1",
    name: "검증 회사",
    role: "owner",
    verified: true,
    bizNoMasked: "123-45-*****",
    region: "서울",
    kind: "active",
  },
  plan: {
    planName: "Team",
    status: "수동 검토",
    priceLabel: "월 99,000원",
    renewalLabel: "매월",
    included: ["지원사업 매칭", "AI 초안"],
    nextSteps: ["운영팀 상담"],
  },
  seatUsage: {
    activeSeats: 3,
    pendingInvitations: 1,
    reservedSeats: 4,
    seatLimit: 7,
    availableSeats: 3,
    limitReached: false,
  },
  billingSubscription: subscription,
} satisfies Pick<WorkspaceOverview, "currentCompany" | "plan" | "seatUsage" | "billingSubscription">;

const taxProfile: BillingTaxProfileItem = {
  id: "tax-profile-1",
  companyId: "company-1",
  businessName: "검증 회사",
  businessRegistrationNumberMasked: "123-45-*****",
  recipientName: "청구 담당자",
  recipientEmail: "billing@example.com",
  recipientPhone: "010-0000-0000",
  taxInvoiceEmail: "tax@example.com",
  taxInvoiceEnabled: true,
  billingAddressLine1: "서울시 중구",
  billingAddressLine2: "검증 빌딩",
  postalCode: "04500",
  notes: null,
  source: "database",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

const markdown = renderBillingPaymentInstructions({
  overview,
  taxProfile,
  planRequests: [
    {
      id: "request-1",
      status: "open",
      priority: "normal",
      desiredPlan: "team",
      billingCycle: "annual",
      seatCount: 7,
      email: "billing@example.com",
      subject: "[플랜 전환] Team 7석",
      messagePreview: "연간 결제를 검토합니다.",
      requestedAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    },
  ],
  generatedAt: new Date("2026-06-30T01:00:00.000Z"),
});

assert(markdown.includes("# 검증 회사 수동 결제 안내서"));
assert(markdown.includes("## 현재 계약 기준"));
assert(markdown.includes("| 현재 플랜 | Team |"));
assert(markdown.includes("## 결제 처리 방식"));
assert(markdown.includes("운영팀이 발행한 결제 링크 또는 세금계산서로 진행합니다."));
assert(markdown.includes("## 세금계산서 수신 정보"));
assert(markdown.includes("tax@example.com"));
assert(markdown.includes("## 최근 플랜 전환 요청"));
assert(markdown.includes("| 2026. 06. 30. | Team | 7석 | 연간 | 접수 | billing@example.com |"));
assert(markdown.includes("## 내부 결재 체크리스트"));
assert(markdown.includes("결제 정보는 provider 포털 또는 운영팀이 지정한 보안 채널"));
assert(markdown.includes("## 다음 액션"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "billing_payment_instructions_heading",
    "billing_payment_instructions_contract_basis",
    "billing_payment_instructions_manual_method",
    "billing_payment_instructions_tax_profile",
    "billing_payment_instructions_plan_requests",
    "billing_payment_instructions_next_actions",
  ],
}, null, 2));

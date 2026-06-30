import type { WorkspaceOverview } from "@/lib/server/workspace/overview";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import type { BillingPlanRequestHistoryItem } from "./planRequestHistory";
import type { BillingTaxDocumentItem } from "./taxDocuments";

export type BillingReadinessStatus = "ready" | "attention" | "blocked";

export interface BillingReadinessItem {
  key: string;
  label: string;
  status: BillingReadinessStatus;
  detail: string;
  actionLabel: string | null;
  actionHref: string | null;
}

export interface BillingReadiness {
  score: number;
  status: BillingReadinessStatus;
  statusLabel: string;
  summary: string;
  providerLabel: string;
  items: BillingReadinessItem[];
}

export function buildBillingReadiness(input: {
  overview: WorkspaceOverview;
  planRequests: BillingPlanRequestHistoryItem[];
  taxDocuments?: BillingTaxDocumentItem[];
}): BillingReadiness {
  const legal = getLegalConfig();
  const subscription = input.overview.billingSubscription;
  const providerLabel = subscription.providerLabel;
  const activePlanRequest = input.planRequests.find((request) =>
    request.status === "open" || request.status === "in_progress" || request.status === "waiting"
  ) ?? input.planRequests[0] ?? null;

  const items: BillingReadinessItem[] = [
    {
      key: "subscription-status",
      label: "구독 상태",
      status: subscriptionStatusReadiness(subscription.status),
      detail: `${subscription.planName} 플랜이 ${subscription.statusLabel} 상태입니다. 상태 출처는 ${subscription.sourceLabel}입니다.`,
      actionLabel: subscription.providerPortalUrl ? "provider 포털" : null,
      actionHref: subscription.providerPortalUrl,
    },
    {
      key: "company-verification",
      label: "사업자 확인",
      status: input.overview.currentCompany.verified ? "ready" : "attention",
      detail: input.overview.currentCompany.verified
        ? "회사와 사업자번호가 확인되어 계약 정보로 사용할 수 있습니다."
        : "사업자 확인이 끝나야 계약서와 세금계산서 정보를 안정적으로 맞출 수 있습니다.",
      actionLabel: input.overview.currentCompany.verified ? null : "회사 설정",
      actionHref: input.overview.currentCompany.verified ? null : "/settings",
    },
    {
      key: "seat-usage",
      label: "좌석 사용량",
      status: input.overview.seatUsage.limitReached ? "attention" : "ready",
      detail: input.overview.seatUsage.limitReached
        ? `${subscription.planName} ${input.overview.seatUsage.seatLimit}석 한도에 도달했습니다. 유료 전환 전 좌석 정리가 필요합니다.`
        : `${input.overview.seatUsage.availableSeats.toLocaleString("ko-KR")}석 여유가 있어 현재 팀 구성을 그대로 전환할 수 있습니다.`,
      actionLabel: "팀 관리",
      actionHref: "/team",
    },
    {
      key: "plan-request",
      label: "플랜 전환 요청",
      status: activePlanRequest ? "ready" : "attention",
      detail: activePlanRequest
        ? `${planLabel(activePlanRequest.desiredPlan)} ${activePlanRequest.seatCount ? `${activePlanRequest.seatCount.toLocaleString("ko-KR")}석` : "좌석 미정"} 요청이 ${statusLabel(activePlanRequest.status)} 상태입니다.`
        : "유료 전환 의사를 남기면 운영팀이 좌석, 청구 주기, 계약 방식을 확인할 수 있습니다.",
      actionLabel: "전환 요청",
      actionHref: "#billing-plan-request-form",
    },
    {
      key: "billing-contact",
      label: "청구 연락처",
      status: activePlanRequest?.email ? "ready" : "attention",
      detail: activePlanRequest?.email
        ? `${activePlanRequest.email}로 청구/계약 상담을 이어갈 수 있습니다.`
        : `${legal.supportEmail} 또는 플랜 전환 요청으로 담당 연락처를 남겨야 합니다.`,
      actionLabel: activePlanRequest?.email ? null : "고객지원",
      actionHref: activePlanRequest?.email ? null : "/support",
    },
    {
      key: "billing-tax-documents",
      label: "청구 증빙 파일",
      status: input.taxDocuments && input.taxDocuments.length > 0 ? "ready" : "attention",
      detail: input.taxDocuments && input.taxDocuments.length > 0
        ? `청구 증빙 ${input.taxDocuments.length.toLocaleString("ko-KR")}개가 R2 보관 URL과 함께 저장되어 있습니다.`
        : "사업자등록증, 통장사본 같은 증빙을 보관하면 세금계산서 발행 준비를 빠르게 확인할 수 있습니다.",
      actionLabel: "증빙 관리",
      actionHref: "#billing-tax-documents-panel",
    },
    {
      key: "legal-disclosure",
      label: "운영 법무 정보",
      status: legal.businessRegistrationNumber && legal.businessAddress ? "ready" : "attention",
      detail: legal.businessRegistrationNumber && legal.businessAddress
        ? "사업자 정보와 주소가 법무 고지에 설정되어 있습니다."
        : "배포 환경의 사업자등록번호와 주소가 확정되면 청구 문서에 바로 반영할 수 있습니다.",
      actionLabel: "약관 확인",
      actionHref: "/terms",
    },
    {
      key: "billing-provider",
      label: "결제 provider",
      status: subscription.providerConfigured ? "ready" : "blocked",
      detail: !subscription.providerConfigured
        ? "아직 카드/계좌 결제 provider가 연결되지 않아 자동 결제와 영수증 발행은 비활성입니다."
        : `${providerLabel} 연동 설정이 감지되었습니다. 자동 결제는 ${subscription.automation.autoBillingEnabled ? "켜져 있습니다" : "아직 꺼져 있습니다"}.`,
      actionLabel: subscription.providerPortalUrl ? "provider 포털" : null,
      actionHref: subscription.providerPortalUrl,
    },
  ];
  const score = readinessScore(items);
  const status = readinessStatus(items);

  return {
    score,
    status,
    statusLabel: statusLabelForReadiness(status),
    summary: readinessSummary(status, score, providerLabel),
    providerLabel,
    items,
  };
}

function readinessScore(items: BillingReadinessItem[]): number {
  const points = items.reduce((sum, item) => {
    if (item.status === "ready") return sum + 1;
    if (item.status === "attention") return sum + 0.5;
    return sum;
  }, 0);
  return Math.round((points / items.length) * 100);
}

function readinessStatus(items: BillingReadinessItem[]): BillingReadinessStatus {
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "attention")) return "attention";
  return "ready";
}

function readinessSummary(
  status: BillingReadinessStatus,
  score: number,
  providerLabel: string,
): string {
  if (status === "ready") return `청구 준비도 ${score}%입니다. ${providerLabel} 연동 상태에서 유료 전환을 진행할 수 있습니다.`;
  if (status === "blocked") return `청구 준비도 ${score}%입니다. 결제 provider가 연결되기 전까지는 상담 기반 전환만 가능합니다.`;
  return `청구 준비도 ${score}%입니다. 남은 확인 항목을 정리하면 유료 전환 상담을 바로 이어갈 수 있습니다.`;
}

function statusLabelForReadiness(status: BillingReadinessStatus): string {
  if (status === "ready") return "전환 가능";
  if (status === "blocked") return "provider 필요";
  return "확인 필요";
}

function subscriptionStatusReadiness(status: WorkspaceOverview["billingSubscription"]["status"]): BillingReadinessStatus {
  if (status === "active" || status === "trialing") return "ready";
  if (status === "past_due" || status === "canceled") return "blocked";
  return "attention";
}

function planLabel(value: string | null): string {
  if (value === "team") return "Team";
  if (value === "growth") return "Growth";
  if (value === "enterprise") return "Enterprise";
  return "플랜 미정";
}

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "답변 완료";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

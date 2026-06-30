import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { loadWorkspaceOverview, type WorkspaceOverview } from "@/lib/server/workspace/overview";
import { listBillingPlanRequestHistory, type BillingPlanRequestHistoryItem } from "./planRequestHistory";
import { loadBillingTaxProfile, type BillingTaxProfileItem } from "./taxProfile";

export interface BillingPaymentInstructions {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export async function buildBillingPaymentInstructions(input: {
  access: CompanyAccess;
  session: WebSession | null;
  asOf?: Date;
}): Promise<BillingPaymentInstructions> {
  const generatedAt = input.asOf ?? new Date();
  const [overview, planRequests, taxProfile] = await Promise.all([
    loadWorkspaceOverview({ access: input.access, session: input.session }),
    listBillingPlanRequestHistory({ access: input.access, session: input.session, limit: 5 }),
    loadBillingTaxProfile({ access: input.access, session: input.session }),
  ]);
  const filenameBase = sanitizeDownloadFilename(overview.currentCompany.name, "워크스페이스");
  return {
    filename: `창업노트-${filenameBase}-수동결제안내-${dateStamp(generatedAt)}.md`,
    fallbackFilename: `cunote-billing-payment-instructions-${dateStamp(generatedAt)}.md`,
    markdown: renderBillingPaymentInstructions({
      overview,
      planRequests,
      taxProfile,
      generatedAt,
    }),
  };
}

export function billingPaymentInstructionsDownloadResponse(
  instructions: BillingPaymentInstructions,
): Response {
  return markdownDownloadResponse({
    markdown: instructions.markdown,
    filename: instructions.filename,
    fallbackFilename: instructions.fallbackFilename,
  });
}

export function renderBillingPaymentInstructions(input: {
  overview: Pick<WorkspaceOverview, "currentCompany" | "plan" | "seatUsage" | "billingSubscription">;
  planRequests: BillingPlanRequestHistoryItem[];
  taxProfile: BillingTaxProfileItem;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const { overview, planRequests, taxProfile } = input;
  const subscription = overview.billingSubscription;
  const lines = [
    `# ${overview.currentCompany.name} 수동 결제 안내서`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 결제 provider가 연결되기 전 또는 수동 검토 플랜에서 내부 결재/세금계산서 요청/운영팀 상담에 쓰는 안내서입니다. 카드 번호와 계좌 비밀번호 같은 민감 결제 정보는 이 문서에 입력하지 않습니다.",
    "",
    "## 현재 계약 기준",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["회사", overview.currentCompany.name],
        ["사업자 확인", overview.currentCompany.verified ? "확인됨" : "확인 필요"],
        ["사업자번호", overview.currentCompany.bizNoMasked ?? "미연결"],
        ["현재 플랜", overview.plan.planName],
        ["상태", overview.plan.status],
        ["표시 요금", overview.plan.priceLabel],
        ["갱신/청구", overview.plan.renewalLabel],
        ["좌석", `${overview.seatUsage.activeSeats.toLocaleString("ko-KR")}명 사용 / ${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}명 한도`],
      ],
    ),
    "",
    "## 결제 처리 방식",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["provider", subscription.providerLabel],
        ["구독 상태", subscription.statusLabel],
        ["자동 결제", subscription.automation.autoBillingEnabled ? "활성" : "비활성"],
        ["청구서/영수증", subscription.automation.invoicesEnabled ? "provider 발행" : "운영팀 확인 필요"],
        ["결제 수단", subscription.paymentMethodLabel],
        ["provider 포털", subscription.providerPortalUrl ?? "미설정"],
        ["수동 결제 안내", manualPaymentInstruction()],
      ],
    ),
    "",
    "## 세금계산서 수신 정보",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["상호/법인명", taxProfile.businessName ?? "미입력"],
        ["사업자번호", taxProfile.businessRegistrationNumberMasked ?? "미입력"],
        ["담당자", taxProfile.recipientName ?? "미입력"],
        ["담당자 이메일", taxProfile.recipientEmail ?? "미입력"],
        ["세금계산서 이메일", taxProfile.taxInvoiceEmail ?? "미입력"],
        ["수신 여부", taxProfile.taxInvoiceEnabled ? "수신" : "미설정"],
        ["주소", [taxProfile.postalCode, taxProfile.billingAddressLine1, taxProfile.billingAddressLine2].filter(Boolean).join(" ") || "미입력"],
      ],
    ),
    "",
    "## 최근 플랜 전환 요청",
    "",
    renderPlanRequests(planRequests),
    "",
    "## 내부 결재 체크리스트",
    "",
    ...internalApprovalChecklist(overview, taxProfile),
    "",
    "## 다음 액션",
    "",
    ...nextActions(overview, taxProfile),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderPlanRequests(planRequests: BillingPlanRequestHistoryItem[]): string {
  if (planRequests.length === 0) return "_최근 플랜 전환 요청이 없습니다._";
  return markdownTable(
    ["요청일", "희망 플랜", "좌석", "주기", "상태", "상담 이메일"],
    planRequests.map((request) => [
      formatDate(request.requestedAt),
      planLabel(request.desiredPlan),
      request.seatCount ? `${request.seatCount.toLocaleString("ko-KR")}석` : "미확인",
      cycleLabel(request.billingCycle),
      statusLabel(request.status),
      request.email,
    ]),
  );
}

function internalApprovalChecklist(
  overview: Pick<WorkspaceOverview, "currentCompany" | "seatUsage" | "billingSubscription">,
  taxProfile: BillingTaxProfileItem,
): string[] {
  return [
    `- 사업자 확인: ${overview.currentCompany.verified ? "완료" : "필요"}`,
    `- 좌석 한도: ${overview.seatUsage.activeSeats.toLocaleString("ko-KR")}/${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}명`,
    `- 세금계산서 이메일: ${taxProfile.taxInvoiceEmail ?? "미입력"}`,
    `- 결제 provider: ${overview.billingSubscription.providerConfigured ? "설정됨" : "미설정"}`,
    "- 결제 정보는 provider 포털 또는 운영팀이 지정한 보안 채널에서만 입력한다.",
  ];
}

function nextActions(
  overview: Pick<WorkspaceOverview, "currentCompany" | "billingSubscription">,
  taxProfile: BillingTaxProfileItem,
): string[] {
  const actions: string[] = [];
  if (!overview.currentCompany.verified) {
    actions.push("- `/settings`에서 회사 소유권/사업자 확인을 먼저 완료한다.");
  }
  if (!taxProfile.taxInvoiceEmail) {
    actions.push("- `/billing`에서 세금계산서 수신 이메일을 입력한다.");
  }
  if (!overview.billingSubscription.providerConfigured) {
    actions.push("- provider 결제 전까지 이 문서를 운영팀 또는 내부 결재자에게 공유하고, 결제/계약 조건은 고객지원 스레드에서 확정한다.");
  }
  if (overview.billingSubscription.providerPortalUrl) {
    actions.push("- provider 포털에서 결제수단과 청구서를 확인한다.");
  }
  actions.push("- 플랜 변경 후 `/team`에서 좌석 한도와 초대 상태를 다시 확인한다.");
  return actions;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function manualPaymentInstruction(): string {
  return process.env.CUNOTE_BILLING_PAYMENT_INSTRUCTIONS?.trim()
    || "운영팀 상담 후 결제 링크, 세금계산서, 또는 별도 계약 절차를 안내합니다.";
}

function planLabel(value: string | null): string {
  if (value === "team") return "Team";
  if (value === "growth") return "Growth";
  if (value === "enterprise") return "Enterprise";
  return "미정";
}

function cycleLabel(value: string | null): string {
  if (value === "monthly") return "월간";
  if (value === "annual") return "연간";
  if (value === "undecided") return "상담 후 결정";
  return "미정";
}

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "답변 완료";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
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

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}

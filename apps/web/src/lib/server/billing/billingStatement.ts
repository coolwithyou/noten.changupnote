import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { loadWorkspaceOverview, type WorkspaceOverview, type WorkspaceUsageMetric } from "@/lib/server/workspace/overview";
import { buildBillingReadiness, type BillingReadiness, type BillingReadinessItem } from "./billingReadiness";
import { formatInvoiceMoney, listBillingInvoices, type BillingInvoiceItem } from "./invoices";
import { listBillingPaymentMethods, type BillingPaymentMethodItem } from "./paymentMethods";
import { listBillingPlanRequestHistory, type BillingPlanRequestHistoryItem } from "./planRequestHistory";
import { listBillingTaxDocuments, type BillingTaxDocumentItem } from "./taxDocuments";
import { loadBillingTaxProfile, type BillingTaxProfileItem } from "./taxProfile";

export interface BillingStatement {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export async function buildBillingStatement(input: {
  access: CompanyAccess;
  session: WebSession | null;
  asOf?: Date;
}): Promise<BillingStatement> {
  const generatedAt = input.asOf ?? new Date();
  const [overview, planRequests, invoices, paymentMethods, taxProfile, taxDocuments] = await Promise.all([
    loadWorkspaceOverview({ access: input.access, session: input.session }),
    listBillingPlanRequestHistory({ access: input.access, session: input.session, limit: 10 }),
    listBillingInvoices({ access: input.access, limit: 10 }),
    listBillingPaymentMethods({ access: input.access, limit: 10 }),
    loadBillingTaxProfile({ access: input.access, session: input.session }),
    listBillingTaxDocuments({ access: input.access, limit: 10 }),
  ]);
  const readiness = buildBillingReadiness({ overview, planRequests, taxDocuments });
  const filenameBase = sanitizeDownloadFilename(overview.currentCompany.name, "워크스페이스");

  return {
    filename: `창업노트-${filenameBase}-청구명세-${dateStamp(generatedAt)}.md`,
    fallbackFilename: `cunote-billing-statement-${dateStamp(generatedAt)}.md`,
    markdown: renderBillingStatement({ overview, planRequests, invoices, paymentMethods, taxProfile, taxDocuments, readiness, generatedAt }),
  };
}

export function billingStatementDownloadResponse(statement: BillingStatement): Response {
  return markdownDownloadResponse({
    markdown: statement.markdown,
    filename: statement.filename,
    fallbackFilename: statement.fallbackFilename,
  });
}

function renderBillingStatement(input: {
  overview: WorkspaceOverview;
  planRequests: BillingPlanRequestHistoryItem[];
  invoices: BillingInvoiceItem[];
  paymentMethods: BillingPaymentMethodItem[];
  taxProfile: BillingTaxProfileItem;
  taxDocuments: BillingTaxDocumentItem[];
  readiness: BillingReadiness;
  generatedAt: Date;
}): string {
  const { overview, planRequests, invoices, paymentMethods, taxProfile, taxDocuments, readiness, generatedAt } = input;
  const subscription = overview.billingSubscription;
  const lines = [
    `# ${overview.currentCompany.name} 청구 명세`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트의 현재 플랜, 사용량, 좌석, 청구 연동 상태를 확인하기 위한 내부 검토용 문서입니다. 결제 provider 연결 전까지 카드 정보와 결제 수단은 창업노트가 직접 수집하지 않습니다.",
    "",
    "## 워크스페이스",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["회사", overview.currentCompany.name],
        ["권한", roleLabel(overview.currentCompany.role)],
        ["사업자 확인", overview.currentCompany.verified ? "확인됨" : "확인 필요"],
        ["사업자번호", overview.currentCompany.bizNoMasked ?? "미연결"],
        ["지역", overview.currentCompany.region ?? "미입력"],
        ["상태", overview.currentCompany.kind === "preliminary" ? "수기 프로필" : "활성 회사"],
      ],
    ),
    "",
    "## 현재 플랜",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["플랜", overview.plan.planName],
        ["상태", overview.plan.status],
        ["요금", overview.plan.priceLabel],
        ["갱신/청구", overview.plan.renewalLabel],
        ["상태 출처", subscription.sourceLabel],
        ["청구서", subscription.invoiceStatusLabel],
        ["결제 수단", subscription.paymentMethodLabel],
        ["계약 전환", subscription.providerConfigured ? `${subscription.providerLabel} 설정이 감지되었습니다.` : "유료 전환은 지원팀 상담 후 활성화합니다."],
      ],
    ),
    "",
    "## 구독 상태",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["상태", subscription.statusLabel],
        ["provider", subscription.providerLabel],
        ["자동 결제", subscription.automation.autoBillingEnabled ? "활성" : "비활성"],
        ["청구서/영수증", subscription.automation.invoicesEnabled ? "활성" : "비활성"],
        ["결제 수단 관리", subscription.automation.paymentMethodManaged ? "provider 관리" : "미수집"],
        ["체험 종료", subscription.trialEndsAt ? formatDate(subscription.trialEndsAt) : "해당 없음"],
        ["현재 기간 종료", subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : "해당 없음"],
        ["provider 포털", subscription.providerPortalUrl ? "설정됨" : "미설정"],
      ],
    ),
    "",
    "## 청구 준비도",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["준비도", `${readiness.score}%`],
        ["상태", readiness.statusLabel],
        ["결제 provider", readiness.providerLabel],
        ["요약", readiness.summary],
      ],
    ),
    "",
    renderReadinessItems(readiness.items),
    "",
    "## 포함 기능",
    "",
    overview.plan.included.map((feature) => `- ${feature}`).join("\n"),
    "",
    "## 사용량",
    "",
    markdownTable(
      ["항목", "사용량", "한도", "상태"],
      overview.usage.map((metric) => [
        metric.label,
        usageValue(metric),
        metric.limit ? `${metric.limit.toLocaleString("ko-KR")}${metric.unit}` : "제한 없음",
        metric.description,
      ]),
    ),
    "",
    "## 좌석",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["활성 멤버", `${overview.seatUsage.activeSeats.toLocaleString("ko-KR")}명`],
        ["대기 초대", `${overview.seatUsage.pendingInvitations.toLocaleString("ko-KR")}명`],
        ["예약 좌석", `${overview.seatUsage.reservedSeats.toLocaleString("ko-KR")}명`],
        ["좌석 한도", `${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}명`],
        ["남은 좌석", `${overview.seatUsage.availableSeats.toLocaleString("ko-KR")}명`],
      ],
    ),
    "",
    "## 유료 전환 전 확인 사항",
    "",
    overview.plan.nextSteps.map((step) => `- ${step}`).join("\n"),
    "",
    "## 청구 프로필",
    "",
    renderTaxProfile(taxProfile),
    "",
    "## 청구 증빙 파일",
    "",
    renderTaxDocuments(taxDocuments),
    "",
    "## 결제 수단",
    "",
    renderPaymentMethods(paymentMethods),
    "",
    "## 최근 청구/영수증",
    "",
    renderBillingInvoices(invoices),
    "",
    "## 최근 플랜 전환 요청",
    "",
    renderPlanRequests(planRequests),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderTaxDocuments(documents: BillingTaxDocumentItem[]): string {
  if (documents.length === 0) {
    return "_보관된 청구 증빙 파일이 없습니다._";
  }

  return markdownTable(
    ["종류", "파일", "크기", "상태", "보관 URL", "최근 업데이트"],
    documents.map((document) => [
      document.documentKindLabel,
      document.filename,
      document.sizeLabel,
      document.statusLabel,
      document.archiveUrl,
      formatDate(document.updatedAt),
    ]),
  );
}

function renderTaxProfile(profile: BillingTaxProfileItem): string {
  return markdownTable(
    ["항목", "내용"],
    [
      ["상호/법인명", profile.businessName ?? "미입력"],
      ["사업자번호", profile.businessRegistrationNumberMasked ?? "미입력"],
      ["청구 담당자", profile.recipientName ?? "미입력"],
      ["담당자 이메일", profile.recipientEmail ?? "미입력"],
      ["세금계산서 이메일", profile.taxInvoiceEmail ?? "미입력"],
      ["세금계산서 수신", profile.taxInvoiceEnabled ? "수신" : "미설정"],
      ["주소", [profile.postalCode, profile.billingAddressLine1, profile.billingAddressLine2].filter(Boolean).join(" ") || "미입력"],
      ["최근 업데이트", profile.updatedAt ? formatDate(profile.updatedAt) : "해당 없음"],
    ],
  );
}

function renderPaymentMethods(paymentMethods: BillingPaymentMethodItem[]): string {
  if (paymentMethods.length === 0) {
    return "_아직 등록된 결제수단이 없습니다._";
  }

  return markdownTable(
    ["상태", "결제수단", "기본", "만료", "provider", "최근 업데이트"],
    paymentMethods.map((method) => [
      method.statusLabel,
      method.displayLabel,
      method.isDefault ? "기본" : "보조",
      method.expiryLabel,
      method.provider,
      formatDate(method.updatedAt),
    ]),
  );
}

function renderBillingInvoices(invoices: BillingInvoiceItem[]): string {
  if (invoices.length === 0) {
    return "_아직 수신된 청구서 또는 영수증이 없습니다._";
  }

  return markdownTable(
    ["상태", "청구번호", "금액", "서비스 기간", "provider", "최근 업데이트"],
    invoices.map((invoice) => [
      invoice.statusLabel,
      invoice.invoiceNumber ?? invoice.providerInvoiceId,
      formatInvoiceMoney(invoice.amountPaid || invoice.amountDue, invoice.currency),
      `${formatNullableDate(invoice.periodStart)} - ${formatNullableDate(invoice.periodEnd)}`,
      invoice.provider,
      formatDate(invoice.updatedAt),
    ]),
  );
}

function renderPlanRequests(planRequests: BillingPlanRequestHistoryItem[]): string {
  if (planRequests.length === 0) {
    return "_아직 접수된 플랜 전환 요청이 없습니다._";
  }

  return markdownTable(
    ["상태", "희망 플랜", "좌석", "청구 주기", "요청자", "최근 업데이트"],
    planRequests.map((request) => [
      statusLabel(request.status),
      planLabel(request.desiredPlan),
      request.seatCount ? `${request.seatCount.toLocaleString("ko-KR")}석` : "미정",
      cycleLabel(request.billingCycle),
      request.email,
      formatDate(request.updatedAt),
    ]),
  );
}

function renderReadinessItems(items: BillingReadinessItem[]): string {
  return markdownTable(
    ["항목", "상태", "상세"],
    items.map((item) => [
      item.label,
      readinessItemLabel(item.status),
      item.detail,
    ]),
  );
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function usageValue(metric: WorkspaceUsageMetric): string {
  return `${metric.value.toLocaleString("ko-KR")}${metric.unit}`;
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  if (role === "viewer") return "뷰어";
  return role;
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

function readinessItemLabel(status: BillingReadinessItem["status"]): string {
  if (status === "ready") return "준비됨";
  if (status === "blocked") return "연동 필요";
  return "확인 필요";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function formatNullableDate(value: string | null): string {
  return value ? formatDate(value) : "해당 없음";
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

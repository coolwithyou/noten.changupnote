import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import {
  submitSupportTicket,
  type SupportTicketReceipt,
} from "@/lib/server/support/supportTickets";

export type BillingPlanRequestPlan = "team" | "growth" | "enterprise";
export type BillingPlanRequestCycle = "monthly" | "annual" | "undecided";

export interface BillingPlanRequestInput {
  access: CompanyAccess;
  session: WebSession | null;
  email: string;
  name?: string | null;
  desiredPlan: unknown;
  seatCount: unknown;
  billingCycle: unknown;
  message?: string | null;
}

export interface BillingPlanRequestReceipt extends SupportTicketReceipt {
  desiredPlan: BillingPlanRequestPlan;
  seatCount: number;
  billingCycle: BillingPlanRequestCycle;
}

const PLAN_LABELS: Record<BillingPlanRequestPlan, string> = {
  team: "Team",
  growth: "Growth",
  enterprise: "Enterprise",
};

const CYCLE_LABELS: Record<BillingPlanRequestCycle, string> = {
  monthly: "월간",
  annual: "연간",
  undecided: "상담 후 결정",
};

export class BillingPlanRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingPlanRequestError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export async function submitBillingPlanRequest(
  input: BillingPlanRequestInput,
): Promise<BillingPlanRequestReceipt> {
  const email = normalizeEmail(input.email);
  const desiredPlan = normalizePlan(input.desiredPlan);
  const billingCycle = normalizeCycle(input.billingCycle);
  const seatCount = normalizeSeatCount(input.seatCount);
  const message = normalizeMessage(input.message);
  const receipt = await submitSupportTicket({
    email,
    name: normalizeName(input.name),
    category: "billing",
    subject: `[플랜 전환] ${PLAN_LABELS[desiredPlan]} ${seatCount}석`,
    message: buildTicketMessage({ desiredPlan, billingCycle, seatCount, message }),
    access: input.access,
    session: input.session,
    metadata: {
      kind: "billing_plan_request",
      desiredPlan,
      billingCycle,
      seatCount,
      requestedByRole: input.access.role,
    },
  });

  return {
    ...receipt,
    desiredPlan,
    seatCount,
    billingCycle,
  };
}

function buildTicketMessage(input: {
  desiredPlan: BillingPlanRequestPlan;
  billingCycle: BillingPlanRequestCycle;
  seatCount: number;
  message: string | null;
}): string {
  return [
    `희망 플랜: ${PLAN_LABELS[input.desiredPlan]}`,
    `예상 좌석: ${input.seatCount}석`,
    `청구 주기: ${CYCLE_LABELS[input.billingCycle]}`,
    "",
    input.message ?? "추가 요청사항 없음",
  ].join("\n");
}

function normalizePlan(value: unknown): BillingPlanRequestPlan {
  if (value === "team" || value === "growth" || value === "enterprise") return value;
  throw new BillingPlanRequestError("invalid_plan", "희망 플랜을 확인해주세요.", 400, "desiredPlan");
}

function normalizeCycle(value: unknown): BillingPlanRequestCycle {
  if (value === "monthly" || value === "annual" || value === "undecided") return value;
  throw new BillingPlanRequestError("invalid_billing_cycle", "청구 주기를 확인해주세요.", 400, "billingCycle");
}

function normalizeSeatCount(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(numberValue) && numberValue >= 1 && numberValue <= 200) return numberValue;
  throw new BillingPlanRequestError("invalid_seat_count", "좌석 수는 1명 이상 200명 이하로 입력해주세요.", 400, "seatCount");
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BillingPlanRequestError("invalid_email", "상담받을 이메일을 확인해주세요.", 400, "email");
  }
  return email.slice(0, 160);
}

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}

function normalizeMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

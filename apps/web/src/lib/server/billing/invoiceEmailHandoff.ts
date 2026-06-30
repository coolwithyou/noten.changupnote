import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import {
  BillingInvoiceError,
  formatInvoiceMoney,
  loadBillingInvoiceForCompany,
  normalizeBillingInvoiceId,
  type BillingInvoiceItem,
} from "./invoices";
import { loadBillingTaxProfile, type BillingTaxProfileItem } from "./taxProfile";

export interface BillingInvoiceEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export interface BillingInvoiceEmailHandoffInput {
  invoice: BillingInvoiceItem;
  companyName: string;
  recipientEmail: string;
  recipientName?: string | null;
  generatedAt?: Date;
}

export async function buildBillingInvoiceEmailHandoff(input: {
  access: CompanyAccess;
  session: WebSession | null;
  invoiceId: string;
  asOf?: Date;
}): Promise<BillingInvoiceEmailHandoff> {
  const invoiceId = normalizeBillingInvoiceId(input.invoiceId);
  const invoice = await loadBillingInvoiceForCompany({
    access: input.access,
    invoiceId,
  });
  if (!invoice) {
    throw new BillingInvoiceError("billing_invoice_not_found", "청구 이력을 찾지 못했습니다.", 404, "invoiceId");
  }

  const taxProfile = await loadBillingTaxProfile({
    access: input.access,
    session: input.session,
  });
  const recipientEmail = resolveRecipientEmail(taxProfile, input.session);
  if (!recipientEmail) {
    throw new BillingInvoiceError("billing_invoice_email_recipient_missing", "청구 메일 수신 이메일을 확인해주세요.", 409, "recipientEmail");
  }

  return renderBillingInvoiceEmailHandoff({
    invoice,
    companyName: taxProfile.businessName ?? "창업노트 워크스페이스",
    recipientEmail,
    recipientName: taxProfile.recipientName ?? input.session?.user.name ?? null,
    generatedAt: input.asOf ?? new Date(),
  });
}

export function renderBillingInvoiceEmailHandoff(
  input: BillingInvoiceEmailHandoffInput,
): BillingInvoiceEmailHandoff {
  const generatedAt = input.generatedAt ?? new Date();
  const invoiceLabel = input.invoice.invoiceNumber ?? input.invoice.providerInvoiceId;
  const filenameBase = sanitizeDownloadFilename(`${input.companyName}-${invoiceLabel}`, "청구서");
  const subject = `${input.companyName} 창업노트 청구서 ${invoiceLabel}`;
  const eml = renderEml({
    from: billingFromAddress(),
    to: input.recipientEmail,
    subject,
    date: generatedAt,
    body: [
      `${input.recipientName ?? "담당자"}님, 안녕하세요.`,
      "",
      `${input.companyName}의 창업노트 청구 이력 확인용 메일입니다.`,
      "",
      `청구번호: ${invoiceLabel}`,
      `상태: ${input.invoice.statusLabel}`,
      `결제 금액: ${formatInvoiceMoney(input.invoice.amountPaid || input.invoice.amountDue, input.invoice.currency)}`,
      `세금/부가세: ${formatInvoiceMoney(input.invoice.taxAmount, input.invoice.currency)}`,
      `서비스 기간: ${formatNullableDate(input.invoice.periodStart)} - ${formatNullableDate(input.invoice.periodEnd)}`,
      `발행일: ${formatNullableDate(input.invoice.issuedAt)}`,
      `결제일: ${formatNullableDate(input.invoice.paidAt)}`,
      "",
      input.invoice.hostedInvoiceUrl ? `provider 청구서: ${input.invoice.hostedInvoiceUrl}` : null,
      input.invoice.receiptUrl ? `provider 영수증: ${input.invoice.receiptUrl}` : null,
      "",
      "이 메일 파일은 창업노트에 보관된 provider 청구 이벤트를 바탕으로 만든 handoff 문서입니다.",
      "세금계산서와 법정 영수증은 실제 provider 또는 운영팀 발행본을 기준으로 확인해주세요.",
      "",
      "-- ",
      "창업노트 청구",
      "",
    ].filter((line): line is string => line !== null).join("\n"),
  });

  return {
    filename: `창업노트-${filenameBase}-청구메일.eml`,
    fallbackFilename: `cunote-billing-invoice-${input.invoice.id.slice(0, 8)}.eml`,
    eml,
  };
}

export function billingInvoiceEmailHandoffDownloadResponse(
  handoff: BillingInvoiceEmailHandoff,
): Response {
  return textDownloadResponse({
    body: handoff.eml,
    filename: handoff.filename,
    fallbackFilename: handoff.fallbackFilename,
    contentType: "message/rfc822; charset=utf-8",
  });
}

function resolveRecipientEmail(profile: BillingTaxProfileItem, session: WebSession | null): string | null {
  return profile.taxInvoiceEmail?.trim()
    || profile.recipientEmail?.trim()
    || session?.user.email?.trim()
    || null;
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
    "X-Cunote-Handoff: billing-invoice-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function billingFromAddress(): string {
  const email = process.env.CUNOTE_BILLING_EMAIL?.trim()
    || process.env.CUNOTE_SUPPORT_EMAIL?.trim()
    || "support@changupnote.com";
  return `=?UTF-8?B?${Buffer.from("창업노트 청구", "utf8").toString("base64")}?= <${email}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatNullableDate(value: string | null): string {
  if (!value) return "해당 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

import assert from "node:assert/strict";
import { renderBillingInvoiceEmailHandoff } from "./invoiceEmailHandoff";
import type { BillingInvoiceItem } from "./invoices";

process.env.CUNOTE_BILLING_EMAIL = "billing@changupnote.com";

const invoice: BillingInvoiceItem = {
  id: "00000000-0000-4000-8000-000000000123",
  provider: "stripe",
  providerInvoiceId: "in_verify_123",
  invoiceNumber: "INV-2026-0001",
  status: "paid",
  statusLabel: "결제 완료",
  currency: "KRW",
  amountDue: 99000,
  amountPaid: 99000,
  taxAmount: 9000,
  hostedInvoiceUrl: "https://billing.example.com/invoices/in_verify_123",
  receiptUrl: "https://billing.example.com/receipts/in_verify_123",
  issuedAt: "2026-06-01T00:00:00.000Z",
  dueAt: "2026-06-10T00:00:00.000Z",
  paidAt: "2026-06-02T00:00:00.000Z",
  periodStart: "2026-06-01T00:00:00.000Z",
  periodEnd: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-02T01:00:00.000Z",
};

const handoff = renderBillingInvoiceEmailHandoff({
  invoice,
  companyName: "검증 회사",
  recipientEmail: "billing@example.com",
  recipientName: "청구 담당자",
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});

assert.equal(handoff.filename, "창업노트-검증 회사-INV-2026-0001-청구메일.eml");
assert.equal(handoff.fallbackFilename, "cunote-billing-invoice-00000000.eml");
assert(handoff.eml.includes("From: =?UTF-8?B?"));
assert(handoff.eml.includes("To: <billing@example.com>"));
assert(handoff.eml.includes("Subject: =?UTF-8?B?"));
assert(handoff.eml.includes("Content-Type: text/plain; charset=UTF-8"));
assert(handoff.eml.includes("X-Cunote-Handoff: billing-invoice-email"));
assert(handoff.eml.includes("검증 회사의 창업노트 청구 이력 확인용 메일입니다."));
assert(handoff.eml.includes("청구번호: INV-2026-0001"));
assert(handoff.eml.includes("결제 금액: ₩99,000"));
assert(handoff.eml.includes("세금/부가세: ₩9,000"));
assert(handoff.eml.includes("provider 청구서: https://billing.example.com/invoices/in_verify_123"));
assert(handoff.eml.includes("provider 영수증: https://billing.example.com/receipts/in_verify_123"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "billing_invoice_email_handoff_filename",
    "billing_invoice_email_handoff_headers",
    "billing_invoice_email_handoff_recipient",
    "billing_invoice_email_handoff_amounts",
    "billing_invoice_email_handoff_provider_links",
  ],
}, null, 2));

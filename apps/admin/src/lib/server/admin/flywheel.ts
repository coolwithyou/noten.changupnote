import { getAdminSql } from "@/lib/server/db/client";

export interface OpsFlywheelSurface {
  key: string;
  table: string;
  label: string;
  count: number | null;
  available: boolean;
}

export interface OpsFlywheelSnapshot {
  generatedAt: string;
  surfaces: OpsFlywheelSurface[];
}

const SURFACES = [
  ["extraction_log", "extraction_log", "추출 이력"],
  ["feedback", "feedback", "사용자 피드백"],
  ["review_queue", "feedback", "리뷰 큐 후보"],
  ["match_events", "match_events", "매칭 이벤트"],
  ["golden_set", "golden_set", "골든셋"],
  ["eval_runs", "eval_runs", "평가 실행"],
  ["grant_insight_snapshots", "grant_insight_snapshots", "지원사업 인사이트"],
  ["grant_attachment_archives", "grant_attachment_archives", "첨부 아카이브"],
  ["grant_document_drafts", "grant_document_drafts", "지원서 초안"],
  ["grant_document_draft_quality_events", "grant_document_draft_events", "초안 품질 피드백"],
  ["support_tickets", "support_tickets", "고객지원 티켓"],
  ["billing_subscriptions", "billing_subscriptions", "구독 상태"],
  ["billing_tax_profiles", "billing_tax_profiles", "세금계산서 프로필"],
  ["billing_tax_documents", "billing_tax_documents", "청구 증빙"],
  ["billing_invoices", "billing_invoices", "청구서"],
  ["billing_payment_methods", "billing_payment_methods", "결제수단"],
  ["billing_webhook_events", "billing_webhook_events", "결제 웹훅"],
] as const;

export async function getOpsFlywheelSnapshot(): Promise<OpsFlywheelSnapshot> {
  const surfaces = await Promise.all(
    SURFACES.map(async ([key, table, label]) => ({
      key,
      table,
      label,
      ...(await countTableRows(table)),
    })),
  );

  return {
    generatedAt: new Date().toISOString(),
    surfaces,
  };
}

async function countTableRows(table: string): Promise<{ count: number | null; available: boolean }> {
  const sql = getAdminSql();
  const exists = await sql<{ exists: boolean }[]>`
    select to_regclass(${`public.${table}`}) is not null as exists
  `;
  if (!exists[0]?.exists) return { count: null, available: false };

  const quoted = quoteIdentifier(table);
  const rows = await sql.unsafe<{ value: number }[]>(`select count(*)::int as value from ${quoted}`);
  return { count: rows[0]?.value ?? 0, available: true };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

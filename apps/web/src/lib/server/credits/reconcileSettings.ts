// 대사 scope 5 임계값을 credit_settings 에서 로드한다(설계 4.7 / 12.7 / 13.1).
//
// 스키마 변경 없이 settings KV 로 조정 가능한 값만 사용한다:
//   - admin_grant_review_threshold: admin_grant 발행 총량 경보 임계(기본 50,000).
//   - usage_anomaly_hourly_credits: 단일 사용자 1시간 차감 임계(12.7 — 대시보드 이상 신호에서 사용).
//   - company_new_member_window_days / company_new_member_threshold: 13.1 초대 급증(7일/5인).
// settings 행이 없으면 기본값으로 폴백한다(시드에 등재되어 있으나 방어적으로).
import { sql } from "drizzle-orm";
import type { CunoteDb } from "@/lib/server/db/client";

export interface ReconcileThresholds {
  adminGrantAlertThreshold: number;
  usageAnomalyHourlyCredits: number;
  companyNewMemberWindowDays: number;
  companyNewMemberThreshold: number;
}

const DEFAULTS: ReconcileThresholds = {
  adminGrantAlertThreshold: 50000,
  usageAnomalyHourlyCredits: 100000,
  companyNewMemberWindowDays: 7,
  companyNewMemberThreshold: 5,
};

function numFrom(value: unknown, fallback: number): number {
  if (value && typeof value === "object" && "value" in value) {
    const v = (value as { value: unknown }).value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return fallback;
}

export async function loadReconcileThresholds(db: CunoteDb): Promise<ReconcileThresholds> {
  const rows = await db.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM credit_settings
    WHERE key IN (
      'admin_grant_review_threshold',
      'usage_anomaly_hourly_credits',
      'company_new_member_window_days',
      'company_new_member_threshold'
    )
  `);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    adminGrantAlertThreshold: numFrom(map.get("admin_grant_review_threshold"), DEFAULTS.adminGrantAlertThreshold),
    usageAnomalyHourlyCredits: numFrom(map.get("usage_anomaly_hourly_credits"), DEFAULTS.usageAnomalyHourlyCredits),
    companyNewMemberWindowDays: numFrom(map.get("company_new_member_window_days"), DEFAULTS.companyNewMemberWindowDays),
    companyNewMemberThreshold: numFrom(map.get("company_new_member_threshold"), DEFAULTS.companyNewMemberThreshold),
  };
}

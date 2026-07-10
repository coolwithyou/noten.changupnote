import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PricingRuleRow {
  id: string;
  rule_type: string;
  feature_code: string | null;
  model: string | null;
  input_millicredits_per_1k: string | null;
  output_millicredits_per_1k: string | null;
  cache_read_millicredits_per_1k: string | null;
  cache_write_millicredits_per_1k: string | null;
  flat_credits: string | null;
  effective_from: string;
  effective_until: string | null;
  created_by_admin_id: string;
  note: string | null;
  created_at: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 요율의 대표값을 계산한다. model_token은 output 우선(없으면 input), feature_flat은 flat_credits. */
function representativeValue(
  ruleType: string,
  values: {
    inputMillicreditsPer1k: number | null;
    outputMillicreditsPer1k: number | null;
    flatCredits: number | null;
  },
): number | null {
  if (ruleType === "model_token") {
    return values.outputMillicreditsPer1k ?? values.inputMillicreditsPer1k;
  }
  if (ruleType === "feature_flat") {
    return values.flatCredits;
  }
  return null;
}

/** postgres.js bigint(문자열)을 number 또는 null로 변환한다. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");
    const sql = getAdminSql();
    const rules = await sql<PricingRuleRow[]>`
      SELECT * FROM credit_pricing_rules ORDER BY created_at DESC LIMIT 100
    `;
    return adminData({ rules });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "owner");

    const body = await readJson(request);

    const ruleType = typeof body.ruleType === "string" ? body.ruleType : null;
    const featureCode = typeof body.featureCode === "string" ? body.featureCode : null;
    const model = typeof body.model === "string" ? body.model : null;
    const inputMillicreditsPer1k = typeof body.inputMillicreditsPer1k === "number" ? body.inputMillicreditsPer1k : null;
    const outputMillicreditsPer1k = typeof body.outputMillicreditsPer1k === "number" ? body.outputMillicreditsPer1k : null;
    const cacheReadMillicreditsPer1k = typeof body.cacheReadMillicreditsPer1k === "number" ? body.cacheReadMillicreditsPer1k : null;
    const cacheWriteMillicreditsPer1k = typeof body.cacheWriteMillicreditsPer1k === "number" ? body.cacheWriteMillicreditsPer1k : null;
    const flatCredits = typeof body.flatCredits === "number" ? body.flatCredits : null;
    const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : null;
    const note = typeof body.note === "string" ? body.note : null;
    const confirmed = body.confirmed === true;

    // 1. 필수값 검증
    if (!ruleType) {
      return adminError("invalid_request", "ruleType은 필수입니다.", 400, "ruleType");
    }
    if (!effectiveFrom) {
      return adminError("invalid_request", "effectiveFrom은 필수입니다.", 400, "effectiveFrom");
    }

    const effectiveFromMs = Date.parse(effectiveFrom);
    if (!Number.isFinite(effectiveFromMs)) {
      return adminError("invalid_request", "effectiveFrom은 유효한 ISO 날짜여야 합니다.", 400, "effectiveFrom");
    }

    const sql = getAdminSql();

    // 2. 현행 요율 조회 (같은 rule_type + feature_code + model, effective_until IS NULL)
    const currentRows = await sql<PricingRuleRow[]>`
      SELECT * FROM credit_pricing_rules
      WHERE rule_type = ${ruleType}
        AND feature_code IS NOT DISTINCT FROM ${featureCode ?? null}
        AND model IS NOT DISTINCT FROM ${model ?? null}
        AND effective_until IS NULL
      ORDER BY effective_from DESC
      LIMIT 1
    `;
    const current = currentRows[0] ?? null;

    // 대표값 계산
    const newRepresentative = representativeValue(ruleType, {
      inputMillicreditsPer1k,
      outputMillicreditsPer1k,
      flatCredits,
    });
    const currentRepresentative = current
      ? representativeValue(ruleType, {
          inputMillicreditsPer1k: toNumberOrNull(current.input_millicredits_per_1k),
          outputMillicreditsPer1k: toNumberOrNull(current.output_millicredits_per_1k),
          flatCredits: toNumberOrNull(current.flat_credits),
        })
      : null;

    // 3. 인상 판정: 신규 대표값 > 현행 대표값이면 인상. 인상 + 7일 미만 예고 → 400
    if (
      current &&
      currentRepresentative !== null &&
      newRepresentative !== null &&
      newRepresentative > currentRepresentative
    ) {
      const noticeThresholdMs = Date.now() + SEVEN_DAYS_MS;
      if (effectiveFromMs < noticeThresholdMs) {
        return adminError(
          "rate_increase_requires_7d_notice",
          "요율 인상은 최소 7일 전에 예고해야 합니다. effectiveFrom을 7일 이후로 설정하세요.",
          400,
          "effectiveFrom",
        );
      }
    }

    // 4. 10배 변화 판정: 현행 대표값 대비 비율이 10배 이상 또는 1/10 이하이면 confirmed 필요
    if (
      current &&
      currentRepresentative !== null &&
      currentRepresentative > 0 &&
      newRepresentative !== null &&
      !confirmed
    ) {
      const ratio = newRepresentative / currentRepresentative;
      if (ratio >= 10 || ratio <= 0.1) {
        return adminError(
          "rate_change_exceeds_10x",
          "요율 변화가 10배를 초과합니다. confirmed=true로 재요청하여 확인하세요.",
          400,
        );
      }
    }

    // 5. UPDATE 금지 — 트랜잭션으로 이전 행 마감 + 새 행 INSERT
    await sql.begin(async (tx) => {
      await tx`
        UPDATE credit_pricing_rules
        SET effective_until = ${effectiveFrom}::timestamptz
        WHERE rule_type = ${ruleType}
          AND feature_code IS NOT DISTINCT FROM ${featureCode ?? null}
          AND model IS NOT DISTINCT FROM ${model ?? null}
          AND effective_until IS NULL
      `;
      await tx`
        INSERT INTO credit_pricing_rules
          (rule_type, feature_code, model,
           input_millicredits_per_1k, output_millicredits_per_1k,
           cache_read_millicredits_per_1k, cache_write_millicredits_per_1k,
           flat_credits, effective_from, created_by_admin_id, note)
        VALUES (
          ${ruleType}, ${featureCode ?? null}, ${model ?? null},
          ${inputMillicreditsPer1k ?? null}, ${outputMillicreditsPer1k ?? null},
          ${cacheReadMillicreditsPer1k ?? null}, ${cacheWriteMillicreditsPer1k ?? null},
          ${flatCredits ?? null}, ${effectiveFrom}::timestamptz, ${session.user.id}, ${note ?? null}
        )
      `;
    });

    await insertCreditAuditLog({
      action: "pricing_rule.published",
      actorSession: session,
      targetType: "pricing_rule",
      targetId: `${ruleType}:${featureCode ?? ""}:${model ?? ""}`,
      before: (current as unknown as Record<string, unknown> | null) ?? null,
      after: {
        ruleType,
        featureCode,
        model,
        inputMillicreditsPer1k,
        outputMillicreditsPer1k,
        cacheReadMillicreditsPer1k,
        cacheWriteMillicreditsPer1k,
        flatCredits,
        effectiveFrom,
      },
      reason: note ?? null,
    });

    return adminData({ ok: true });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}

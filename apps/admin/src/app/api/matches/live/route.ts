import { DEFAULT_ANTHROPIC_MODEL } from "@cunote/core/bizinfo/llm-criteria";
import { runLiveCompanyMatch } from "@cunote/core/matching/live-company-match";
import {
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "@cunote/core/popbill/check-biz-info";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LiveMatchRequest {
  bizNo?: string;
  kstartupLimit?: number;
  bizinfoLimit?: number;
  bizinfoLlm?: boolean;
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "viewer");
    const body = await request.json() as LiveMatchRequest;
    const popbill = readPopbillEnvConfig();
    const checkCorpNum = body.bizNo ? sanitizeCorpNum(body.bizNo) : popbill.checkCorpNum;
    const kstartupLimit = clampInteger(body.kstartupLimit, 1, 20, 5);
    const bizinfoLimit = clampInteger(body.bizinfoLimit, 0, 5, 1);
    const bizinfoLlm = body.bizinfoLlm !== false && bizinfoLimit > 0;

    const report = await runLiveCompanyMatch({
      kstartupServiceKey: requiredEnv("KSTARTUP_SERVICE_KEY"),
      bizinfoServiceKey: requiredEnv("BIZINFO_SERVICE_KEY"),
      popbillCredentials: popbill.credentials,
      checkCorpNum,
      anthropicApiKey: bizinfoLlm ? requiredEnv("ANTHROPIC_API_KEY") : null,
      anthropicModel: process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      kstartupLimit,
      bizinfoLimit,
      bizinfoLlm,
    });

    return Response.json(report);
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return adminError(
      "live_match_failed",
      error instanceof Error ? error.message : "실시간 매칭 요청에 실패했습니다.",
      400,
    );
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env key: ${name}`);
  return value;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

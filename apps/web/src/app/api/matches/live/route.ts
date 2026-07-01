import { DEFAULT_ANTHROPIC_MODEL } from "@cunote/core/bizinfo/llm-criteria";
import { runLiveCompanyMatch } from "@cunote/core/matching/live-company-match";
import {
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "@cunote/core/popbill/check-biz-info";
import { NextResponse } from "next/server";

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
    if (process.env.NODE_ENV !== "production") {
      const { loadMonorepoEnv } = await import("@/lib/server/loadMonorepoEnv");
      loadMonorepoEnv();
    }
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

    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unknown live match error",
    }, { status: 400 });
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

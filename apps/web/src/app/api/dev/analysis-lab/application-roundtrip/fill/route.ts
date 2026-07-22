import { NextResponse } from "next/server";
import {
  ApplicationRoundtripFillError,
  fillApplicationRoundtrip,
} from "@/lib/server/analysis-lab/application-roundtrip/fill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as {
    grantId?: unknown;
    runId?: unknown;
    attachmentId?: unknown;
    values?: unknown;
    choices?: unknown;
    fieldChoices?: unknown;
  } | null;
  const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
  const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
  const attachmentId = typeof body?.attachmentId === "string" ? body.attachmentId.trim() : "";
  const values = isStringRecord(body?.values) ? body.values : null;
  const choices = body?.choices === undefined ? {} : isStringArrayRecord(body.choices) ? body.choices : null;
  const fieldChoices = body?.fieldChoices === undefined ? {} : isStringArrayRecord(body.fieldChoices) ? body.fieldChoices : null;
  if (!grantId || !runId || !attachmentId || !values || !choices || !fieldChoices) {
    return NextResponse.json(
      { error: "invalid_request", message: "grantId, runId, attachmentId, 문자열 values와 문자열 배열 choices/fieldChoices가 필요합니다." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({
      fill: await fillApplicationRoundtrip({ grantId, runId, attachmentId, values, choices, fieldChoices }),
    });
  } catch (error) {
    if (error instanceof ApplicationRoundtripFillError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "지원서 채움·저장에 실패했습니다.";
    return NextResponse.json({ error: "fill_failed", message }, { status: 500 });
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => Array.isArray(item)
      && item.every((optionId) => typeof optionId === "string"));
}

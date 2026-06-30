import { appData, appError } from "@/lib/server/appApi/envelope";
import {
  AdminMatchingEvalError,
  runAdminMatchingEval,
} from "@/lib/server/admin/matchingEval";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdminAccess();
    const url = new URL(request.url);
    const result = await runAdminMatchingEval({
      goldenVer: stringValue(url.searchParams.get("goldenVer")),
      write: false,
    });
    return appData(result);
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    if (error instanceof AdminMatchingEvalError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_matching_eval_failed", error instanceof Error ? error.message : "매칭 평가를 실행하지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminAccess();
    const body = await readJson(request);
    const result = await runAdminMatchingEval({
      goldenVer: stringValue(body.goldenVer),
      write: true,
    });
    return appData(result, { status: 201 });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    if (error instanceof AdminMatchingEvalError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_matching_eval_write_failed", error instanceof Error ? error.message : "매칭 평가 결과를 저장하지 못했습니다.");
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

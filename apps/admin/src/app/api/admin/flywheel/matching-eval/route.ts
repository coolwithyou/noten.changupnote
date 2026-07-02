import { AdminMatchingEvalError, runAdminMatchingEval } from "@/lib/server/admin/matchingEval";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdminSession();
    const url = new URL(request.url);
    return adminData(await runAdminMatchingEval({
      goldenVer: stringValue(url.searchParams.get("goldenVer")),
      write: false,
    }));
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminMatchingEvalError) return adminError(error.code, error.message, error.status);
    return adminError("admin_matching_eval_failed", error instanceof Error ? error.message : "매칭 평가를 실행하지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();
    const body = await readJson(request);
    return adminData(await runAdminMatchingEval({
      goldenVer: stringValue(body.goldenVer),
      write: true,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminMatchingEvalError) return adminError(error.code, error.message, error.status);
    return adminError("admin_matching_eval_write_failed", error instanceof Error ? error.message : "매칭 평가 결과를 저장하지 못했습니다.");
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

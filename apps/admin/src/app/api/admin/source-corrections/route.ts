import { requireAdminSession, AdminRequiredError } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { loadAdminSourceCorrections, reviewSourceCorrection, sourceCorrectionError } from "@/lib/server/admin/sourceCorrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "support");
    if (process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED !== "true") throw sourceCorrectionError("source_corrections_disabled", "원천 정정 기능이 비활성입니다.", 503);
    return adminData(await loadAdminSourceCorrections(admin));
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "support");
    if (process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED !== "true") throw sourceCorrectionError("source_corrections_disabled", "원천 정정 기능이 비활성입니다.", 503);
    const body = await readJson(request);
    if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id) || !Number.isInteger(body.revision)) throw sourceCorrectionError("invalid_request", "정정 요청 식별자와 버전을 확인해주세요.");
    return adminData(await reviewSourceCorrection({ admin, id: body.id, revision: body.revision as number, action: body.action, note: body.note }));
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
  const role = handleRoleError(error); if (role) return role;
  if (error instanceof Error && "code" in error && "status" in error) return adminError(String(error.code), error.message, Number(error.status));
  return adminError("source_correction_failed", "원천 정정 처리를 확인해주세요.");
}

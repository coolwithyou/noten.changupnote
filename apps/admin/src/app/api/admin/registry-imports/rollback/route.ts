import { RegistryImportError, rollbackRegistrySource } from "@/lib/server/admin/registryImports";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "admin");
    const body = await readJson(request);
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!runId) return adminError("invalid_registry_run", "되돌릴 버전을 선택해 주세요.", 400, "runId");
    return adminData(await rollbackRegistrySource({ runId, adminUserId: admin.user.id }));
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    if (error instanceof RegistryImportError) return adminError(error.code, error.message, error.status);
    return adminError("registry_rollback_failed", error instanceof Error ? error.message : "이전 버전으로 되돌리지 못했습니다.");
  }
}


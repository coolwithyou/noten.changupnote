import { listRegistryImportRuns, registrySourceOptions } from "@/lib/server/admin/registryImports";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "admin");
    const runs = await listRegistryImportRuns();
    return adminData({ sources: registrySourceOptions(), runs });
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return adminError("registry_import_list_failed", error instanceof Error ? error.message : "반입 이력을 불러오지 못했습니다.");
  }
}

import {
  isRegistryUploadSource,
  previewRegistryUpload,
  RegistryImportError,
} from "@/lib/server/admin/registryImports";
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
    if (!isRegistryUploadSource(body.sourceKey)) {
      return adminError("invalid_registry_source", "업로드 소스를 선택해 주세요.", 400, "sourceKey");
    }
    const objectKey = typeof body.objectKey === "string" ? body.objectKey : "";
    const filename = typeof body.filename === "string" ? body.filename : "";
    const { records: _records, ...preview } = await previewRegistryUpload({ sourceKey: body.sourceKey, objectKey, filename });
    return adminData(preview);
  } catch (error) {
    return registryRouteError(error, "registry_preview_failed", "CSV를 검증하지 못했습니다.");
  }
}

function registryRouteError(error: unknown, code: string, fallback: string): Response {
  if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
  const roleError = handleRoleError(error);
  if (roleError) return roleError;
  if (error instanceof RegistryImportError) return adminError(error.code, error.message, error.status);
  return adminError(code, error instanceof Error ? error.message : fallback);
}


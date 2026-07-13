import {
  createRegistryUploadTarget,
  isRegistryUploadSource,
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
    const filename = typeof body.filename === "string" ? body.filename : "";
    const contentType = typeof body.contentType === "string" ? body.contentType : "text/csv";
    const fileSize = typeof body.fileSize === "number" ? body.fileSize : Number.NaN;
    return adminData(await createRegistryUploadTarget({ sourceKey: body.sourceKey, filename, contentType, fileSize }));
  } catch (error) {
    return registryRouteError(error, "registry_upload_url_failed", "업로드 URL을 만들지 못했습니다.");
  }
}

function registryRouteError(error: unknown, code: string, fallback: string): Response {
  if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
  const roleError = handleRoleError(error);
  if (roleError) return roleError;
  if (error instanceof RegistryImportError) return adminError(error.code, error.message, error.status);
  return adminError(code, error instanceof Error ? error.message : fallback);
}


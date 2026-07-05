import { notFound } from "next/navigation";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { loadGrantDocumentPreview } from "@/lib/server/documents/documentPreview";
import { DocumentPreviewView } from "@/features/document-viewer/DocumentPreviewView";

export const dynamic = "force-dynamic";

interface PreviewPageProps {
  params: Promise<{ grantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function GrantDocumentPreviewPage({ params, searchParams }: PreviewPageProps) {
  const { grantId } = await params;
  await requirePreviewAccess(grantId);

  const preview = await loadGrantDocumentPreview({ grantId });
  if (!preview) notFound();

  const query = await searchParams;
  const requestedSurface = firstParam(query.surface);

  // 선택 규칙: ?surface= 지정이 유효하면 그것, 아니면 page_image 가 있는 첫 surface,
  // 그것도 없으면 첫 surface. (설계 결정 1)
  const surfaceWithPages = preview.surfaces.find((surface) => surface.pageCount > 0);
  const requestedValid = requestedSurface
    ? preview.surfaces.find((surface) => surface.id === requestedSurface)
    : undefined;
  const selectedSurface = requestedValid ?? surfaceWithPages ?? preview.surfaces[0] ?? null;
  const selectedSurfaceId = selectedSurface?.id ?? null;

  const pages = selectedSurfaceId
    ? preview.pages.filter((page) => page.surfaceId === selectedSurfaceId)
    : [];

  // 필드: 선택 surface 일치 우선, 없으면 grant 전체 필드로 fallback (설계 결정 3).
  const surfaceFields = selectedSurfaceId
    ? preview.fields.filter((field) => field.surfaceId === selectedSurfaceId)
    : [];
  const fields = surfaceFields.length > 0 ? surfaceFields : preview.fields;

  return (
    <DocumentPreviewView
      grantId={grantId}
      grant={preview.grant}
      surfaces={preview.surfaces}
      selectedSurfaceId={selectedSurfaceId}
      pages={pages}
      fields={fields}
    />
  );
}

async function requirePreviewAccess(grantId: string) {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, `/grants/${encodeURIComponent(grantId)}/preview`);
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

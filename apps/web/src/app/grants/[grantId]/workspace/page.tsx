import { notFound } from "next/navigation";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { ServiceHeader } from "@/components/app/service-header";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadGrantWorkspaceData } from "@/lib/server/documents/workspaceData";
import { loadServiceApplySheet } from "@/lib/server/serviceData";
import { WorkspaceView } from "@/features/apply-workspace/WorkspaceView";

export const dynamic = "force-dynamic";

interface WorkspacePageProps {
  params: Promise<{ grantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/grants/[grantId]/workspace` 작성 도우미 (Apply Experience v2 · §4.3 · P2-5).
 *
 * 인증(§12 결정 3: requireCompanyAccess 전제) → ApplySheet → ?document= 활성 문서 결정 →
 * workspace 로더(사다리 판정 + draft ensure + 프로필 시드 + 필드 연결) → WorkspaceView.
 * 로더 내부의 draft ensure·시드는 멱등 서버 write 이며, 실제 필드 값 변경은 PATCH(write 권한)로만 이뤄진다.
 */
export default async function GrantWorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const { grantId } = await params;
  const access = await loadWorkspaceAccess(grantId);
  const sheet = await loadServiceApplySheet(grantId, { companyId: access.companyId, userId: access.userId });
  if (!sheet) notFound();

  const query = await searchParams;
  const requestedDocumentKey = firstParam(query.document) ?? null;

  const data = await loadGrantWorkspaceData({ sheet, access, requestedDocumentKey });
  const user = (await getOptionalHeaderUser()) ?? fallbackHeaderUserForDemoAccess(access);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <ServiceHeader
        user={user}
        links={appHeaderLinks({ currentHref: `/grants/${grantId}/workspace` })}
      />
      <WorkspaceView grantId={grantId} data={data} />
    </div>
  );
}

async function loadWorkspaceAccess(grantId: string) {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, `/grants/${encodeURIComponent(grantId)}/workspace`);
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

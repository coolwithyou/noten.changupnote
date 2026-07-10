import { notFound } from "next/navigation";
import { AccountMenu } from "@/components/app/account-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { CreditBalanceWidget } from "@/features/credits/CreditBalanceWidget";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadGrantWorkspaceData } from "@/lib/server/documents/workspaceData";
import { loadServiceApplySheet } from "@/lib/server/serviceData";
import { buildChatGreeting } from "@/lib/server/chat/greeting";
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
  const greeting = buildChatGreeting({
    title: sheet.grant.title,
    applyEnd: sheet.schedule.applyEnd,
    dDay: sheet.schedule.dDay,
  });

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 lg:px-6">
        {/* 계층(공고 요약 → 문서 작성) 표시 겸 상위 복귀 링크. RSC 라 훅 기반 BreadcrumbLink 대신
            breadcrumb-link 스타일을 얹은 순수 <a> 를 쓴다. */}
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <a
                className="transition-colors hover:text-foreground"
                href={`/grants/${encodeURIComponent(grantId)}`}
              >
                공고 요약
              </a>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>문서 작성</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          {user ? <CreditBalanceWidget /> : null}
          {user ? <AccountMenu user={user} /> : null}
        </div>
      </header>
      <WorkspaceView grantId={grantId} data={data} greeting={greeting} />
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

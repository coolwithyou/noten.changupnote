import { notFound } from "next/navigation";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import {
  loadAdminGrantWorkspaceData,
  loadGrantWorkspaceData,
  loadVirtualGrantWorkspaceData,
} from "@/lib/server/documents/workspaceData";
import { loadServiceApplySheet } from "@/lib/server/serviceData";
import {
  isVirtualCompanyServerEnabled,
  resolveVirtualCompanyScenario,
} from "@/lib/server/virtualCompanies/catalog";
import { loadGrantApplySheetForHandoff } from "@/lib/server/grantApplySheetHandoff";
import { buildChatGreeting } from "@/lib/server/chat/greeting";
import { WorkspaceView } from "@/features/apply-workspace/WorkspaceView";
import { buildInstitutionContact } from "@/features/apply-workspace/workspacePresentation";
import {
  buildGrantSimulationCompanyProfile,
  getGrantSimulationAdminIdentity,
} from "@/lib/server/adminGrantSimulation";

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
  const [{ grantId }, query] = await Promise.all([params, searchParams]);
  const requestedBizNo = firstParam(query.biz);
  const requestedAdminPreview = firstParam(query.adminPreview) === "1";
  const virtualScenario = requestedBizNo && isVirtualCompanyServerEnabled()
    ? resolveVirtualCompanyScenario(requestedBizNo)
    : null;
  const adminIdentity = requestedAdminPreview ? await getGrantSimulationAdminIdentity() : null;
  if (requestedAdminPreview && !adminIdentity) notFound();
  if (virtualScenario && adminIdentity) notFound();
  const access = virtualScenario || adminIdentity ? null : await loadWorkspaceAccess(grantId);
  const handoffKey = firstParam(query.handoff);
  const sheetScope = adminIdentity
    ? null
    : virtualScenario
      ? { virtualBizNo: virtualScenario.bizNo }
      : { companyId: access!.companyId, userId: access!.userId };
  const simulationProfile = adminIdentity ? buildGrantSimulationCompanyProfile() : null;
  const sheet = simulationProfile
    ? await loadServiceApplySheet(grantId, { simulationProfile })
    : handoffKey && sheetScope
      ? await loadGrantApplySheetForHandoff(grantId, handoffKey, sheetScope)
      : await loadServiceApplySheet(grantId, sheetScope ?? {});
  if (!sheet) notFound();

  const requestedDocumentKey = firstParam(query.document) ?? null;
  const data = adminIdentity && simulationProfile
    ? await loadAdminGrantWorkspaceData({
        sheet,
        companyProfile: simulationProfile,
        reviewerEmail: adminIdentity.email,
        requestedDocumentKey,
      })
    : virtualScenario
    ? await loadVirtualGrantWorkspaceData({
        sheet,
        virtualCompany: virtualScenario,
        requestedDocumentKey,
      })
    : await loadGrantWorkspaceData({ sheet, access: access!, requestedDocumentKey });
  const greeting = buildChatGreeting({
    title: sheet.grant.title,
    applyEnd: sheet.schedule.applyEnd,
    dDay: sheet.schedule.dDay,
  });
  const institutionContact = buildInstitutionContact({
    agency: sheet.grant.agency,
    applyMethod: sheet.applyMethod,
    deepLink: sheet.deepLink,
  });

  return (
    // 앱형 고정 뷰포트 화면 — 페이지 스크롤 금지. 스크롤은 좌측 프리뷰·우측 패널 내부에서만.
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <WorkspaceView
        key={`${data.activeDocumentKey ?? "no-document"}:${data.draftId ?? "no-draft"}`}
        data={data}
        greeting={greeting}
        institutionContact={institutionContact}
      />
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

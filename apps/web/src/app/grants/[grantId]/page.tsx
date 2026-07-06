import { notFound } from "next/navigation";
import { ApplySheetView } from "@/features/apply-sheet/ApplySheetView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadGrantPreparation } from "@/lib/server/documents/grantPreparation";
import { matchApprovedLessonsForGrant, matchFieldLessonTips } from "@/lib/server/knowledge/lessonContext";
import { loadServiceApplySheet } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

interface GrantDetailPageProps {
  params: Promise<{
    grantId: string;
  }>;
}

export default async function GrantDetailPage({ params }: GrantDetailPageProps) {
  const { grantId } = await params;
  const access = await loadGrantAccess(grantId);
  const sheet = await loadServiceApplySheet(grantId, { companyId: access.companyId, userId: access.userId });
  if (!sheet) notFound();
  const preparation = await loadInitialPreparation(sheet.grant.id, access, sheet);
  const lessonGuide = await loadLessonGuide(sheet.grant.title, sheet.grant.agency);
  const fieldLessonTips = await loadFieldLessonTips(sheet, preparation);
  const user = (await getOptionalHeaderUser()) ?? fallbackHeaderUserForDemoAccess(access);
  return (
    <ApplySheetView
      sheet={sheet}
      user={user}
      initialDrafts={preparation?.drafts ?? []}
      formFields={preparation?.formFields ?? []}
      lessonGuide={lessonGuide}
      fieldLessonTips={fieldLessonTips}
    />
  );
}

// 필드 레벨 팁 매칭(지식 루프 Step 3 두 번째 슬라이스). "입력 필요" 질문 라벨과 서식 필드
// 라벨을 수집(중복 제거)해 승인 lesson 의 fieldPattern 과 대조한다. 실패해도 null 폴백.
async function loadFieldLessonTips(
  sheet: NonNullable<Awaited<ReturnType<typeof loadServiceApplySheet>>>,
  preparation: Awaited<ReturnType<typeof loadInitialPreparation>>,
) {
  try {
    const labels = Array.from(
      new Set([
        ...sheet.applicationPrep.missingProfileFields.map((question) => question.label),
        ...(preparation?.formFields ?? []).map((field) => field.label),
      ]),
    );
    return await matchFieldLessonTips({ title: sheet.grant.title, agency: sheet.grant.agency, labels });
  } catch (error) {
    console.warn(`Field lesson tips match failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// 승인 lesson 매칭(지식 루프 Step 3). 실패해도 페이지는 깨지지 않게 null 폴백.
async function loadLessonGuide(title: string, agency: string | null) {
  try {
    return await matchApprovedLessonsForGrant({ title, agency });
  } catch (error) {
    console.warn(`Lesson guide match failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function loadGrantAccess(grantId: string) {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, `/grants/${encodeURIComponent(grantId)}`);
  }
}

async function loadInitialPreparation(
  grantId: string,
  access: Awaited<ReturnType<typeof loadGrantAccess>>,
  sheet: NonNullable<Awaited<ReturnType<typeof loadServiceApplySheet>>>,
) {
  try {
    return await loadGrantPreparation({ grantId, access, sheet });
  } catch (error) {
    console.warn(`Grant preparation preload failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

import { notFound } from "next/navigation";
import { AppShell } from "@/components/app/app-shell";
import { GrantOverviewView } from "@/features/grant-overview/GrantOverviewView";
import {
  buildGrantSimulationCompanyProfile,
  getGrantSimulationAdminIdentity,
} from "@/lib/server/adminGrantSimulation";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";
import { getRemainingAssistantUses } from "@/lib/server/credits/remainingUses";
import { getGrantPreviewAvailability } from "@/lib/server/documents/documentPreview";
import { loadGrantPreparation } from "@/lib/server/documents/grantPreparation";
import { loadGrantApplySheetForHandoff } from "@/lib/server/grantApplySheetHandoff";
import { recordLessonExposures, type LessonExposureInput } from "@/lib/server/knowledge/knowledgeRepo";
import { matchApprovedLessonsForGrant, matchFieldLessonTips } from "@/lib/server/knowledge/lessonContext";
import { loadServiceApplySheet } from "@/lib/server/serviceData";
import {
  isVirtualCompanyServerEnabled,
  resolveVirtualCompanyScenario,
} from "@/lib/server/virtualCompanies/catalog";

export const dynamic = "force-dynamic";

interface GrantDetailPageProps {
  params: Promise<{
    grantId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function GrantDetailPage({ params, searchParams }: GrantDetailPageProps) {
  const [{ grantId }, query] = await Promise.all([params, searchParams]);
  const requestedBizNo = firstParam(query.biz);
  const requestedAdminPreview = firstParam(query.adminPreview) === "1";
  const virtualScenario = requestedBizNo && isVirtualCompanyServerEnabled()
    ? resolveVirtualCompanyScenario(requestedBizNo)
    : null;
  const adminIdentity = requestedAdminPreview ? await getGrantSimulationAdminIdentity() : null;
  if (requestedAdminPreview && !adminIdentity) notFound();
  if (virtualScenario && adminIdentity) notFound();
  const access = virtualScenario || adminIdentity ? null : await loadGrantAccess(grantId);
  const handoffKey = crypto.randomUUID();
  const sheet = adminIdentity
    ? await loadServiceApplySheet(grantId, { simulationProfile: buildGrantSimulationCompanyProfile() })
    : await loadGrantApplySheetForHandoff(grantId, handoffKey, virtualScenario
      ? { virtualBizNo: virtualScenario.bizNo }
      : { companyId: access!.companyId, userId: access!.userId });
  if (!sheet) notFound();
  const [preparation, previewAvailability, lessonGuide, remainingUses] = await Promise.all([
    access ? loadInitialPreparation(sheet.grant.id, access, sheet) : Promise.resolve(null),
    virtualScenario ? Promise.resolve(null) : loadPreviewAvailability(sheet.grant.id),
    loadLessonGuide(sheet.grant.title, sheet.grant.agency),
    virtualScenario || adminIdentity ? Promise.resolve(null) : getRemainingAssistantUses(),
  ]);
  const fieldLessonTips = await loadFieldLessonTips(sheet, preparation);
  // 노출 텔레메트리(지식 루프 K1): 매칭 결과를 렌더 시점에 raw 기록한다.
  if (access) {
    await recordLessonExposureEvents({
      grantId: sheet.grant.id,
      companyId: access.companyId ?? null,
      userId: access.userId ?? null,
      lessonGuide,
      fieldLessonTips,
    });
  }
  const user = (await getOptionalHeaderUser()) ?? (access ? fallbackHeaderUserForDemoAccess(access) : null);
  return (
    <AppShell user={user}>
      <GrantOverviewView
        sheet={sheet}
        lessonGuide={lessonGuide}
        previewAvailability={previewAvailability}
        remainingUses={remainingUses}
        virtualCompanyName={virtualScenario?.name ?? null}
        virtualCompanyBizNo={virtualScenario?.bizNo ?? null}
        adminPreview={Boolean(adminIdentity)}
        handoffKey={adminIdentity ? null : handoffKey}
      />
    </AppShell>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// 노출 텔레메트리 기록(지식 루프 K1). 서버가 이미 들고 있는 매칭 결과에서 이벤트를 조립해
// batch insert 한다. 노출 1회 = 페이지 뷰 1회 raw 기록(중복 제거 없음 — 집계에서 처리).
//   - grant_panel: 매칭된 각 lesson id 당 1건.
//   - field_tip: byLabel 의 (label, tip) 쌍당 1건(anchorLabel=label). 같은 lesson 이 여러 라벨에
//     매칭되면 여러 건이 정상이다.
// 기록 실패는 절대 페이지를 깨뜨리지 않는다: await + try/catch 로 삼키고 warn(서버리스에서
// 미대기 프로미스가 응답 후 잘릴 수 있어 결정적·검증 가능한 await 방식을 택한다).
async function recordLessonExposureEvents(input: {
  grantId: string;
  companyId: string | null;
  userId: string | null;
  lessonGuide: Awaited<ReturnType<typeof loadLessonGuide>>;
  fieldLessonTips: Awaited<ReturnType<typeof loadFieldLessonTips>>;
}) {
  try {
    const events: LessonExposureInput[] = [];
    if (input.lessonGuide?.matched) {
      for (const group of input.lessonGuide.groups) {
        for (const lesson of group.lessons) {
          events.push({
            lessonId: lesson.id,
            grantId: input.grantId,
            surface: "grant_panel",
            companyId: input.companyId,
            userId: input.userId,
          });
        }
      }
    }
    if (input.fieldLessonTips?.matched) {
      for (const [label, tips] of Object.entries(input.fieldLessonTips.byLabel)) {
        for (const tip of tips) {
          events.push({
            lessonId: tip.id,
            grantId: input.grantId,
            surface: "field_tip",
            anchorLabel: label,
            companyId: input.companyId,
            userId: input.userId,
          });
        }
      }
    }
    await recordLessonExposures(events);
  } catch (error) {
    console.warn(
      `Lesson exposure record failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// 필드 레벨 팁 매칭(지식 루프 Step 3 + K2 fieldKey 격상). "입력 필요" 질문 라벨과 서식 필드
// (label + fieldKey)를 수집해 승인 lesson 의 fieldKey 동등성·fieldPattern 문자열과 대조한다.
//   - missingProfileFields 의 fieldKey 는 회사 프로필 필드 네임스페이스(예: company.biz_no)라 Gate 1
//     표준 key 사전과 다르므로 fieldKey 없이 { label } 만 전달한다(교차 네임스페이스 오탐 방지).
//   - formFields.fieldKey 는 grant_document_fields.fieldKey(Gate 1 표준 key 정렬 대상)라 함께 전달한다.
//   - label 기준 중복 제거·fieldKey 우선은 matchFieldLessonTips 가 처리한다. 실패해도 null 폴백.
async function loadFieldLessonTips(
  sheet: NonNullable<Awaited<ReturnType<typeof loadServiceApplySheet>>>,
  preparation: Awaited<ReturnType<typeof loadInitialPreparation>>,
) {
  try {
    const fields = [
      ...sheet.applicationPrep.missingProfileFields.map((question) => ({ label: question.label })),
      ...(preparation?.formFields ?? []).map((field) => ({ label: field.label, fieldKey: field.fieldKey })),
    ];
    return await matchFieldLessonTips({ title: sheet.grant.title, agency: sheet.grant.agency, fields });
  } catch (error) {
    console.warn(`Field lesson tips match failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// 미리보기 가용성(경량 조회, 계획 2026-07-08 슬라이스 A4). 실패해도 페이지는 깨지지 않게 null 폴백.
async function loadPreviewAvailability(grantId: string) {
  try {
    return await getGrantPreviewAvailability(grantId);
  } catch (error) {
    console.warn(`Preview availability load failed: ${error instanceof Error ? error.message : String(error)}`);
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

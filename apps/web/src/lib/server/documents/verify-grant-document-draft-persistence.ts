import { and, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import * as schema from "@/lib/server/db/schema";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";

loadMonorepoEnv();
process.env.CUNOTE_REPOSITORY_ADAPTER ??= "drizzle";

const [
  { mockUserId },
  { closeCunoteDb, getCunoteDb, withCunoteDbUser },
  { demoCompanyId },
  { loadServiceApplySheet, loadServiceGrants },
  {
    createGrantDocumentDraft,
    recordGrantDocumentDraftExport,
    regenerateGrantDocumentDraftSection,
    submitGrantDocumentDraftFeedback,
    updateGrantDocumentDraft,
  },
] = await Promise.all([
  import("@/lib/server/auth/mockIdentity"),
  import("@/lib/server/db/client"),
  import("@/lib/server/repositories/runtime"),
  import("@/lib/server/serviceData"),
  import("./grantDocumentDrafts"),
]);

const access: CompanyAccess = {
  companyId: demoCompanyId(),
  userId: mockUserId(),
  role: "owner",
  mode: "demo",
};

try {
  const selected = await findDraftableGrant();
  const created = await createGrantDocumentDraft({
    grantId: selected.grantId,
    access,
    request: {
      documentKey: selected.documentKey,
    },
  });
  const regenerated = await createGrantDocumentDraft({
    grantId: selected.grantId,
    access,
    request: {
      documentKey: selected.documentKey,
    },
  });
  if (regenerated.draft.id !== created.draft.id) {
    throw new Error("같은 문서 재생성에서 기존 초안이 갱신되지 않았습니다.");
  }
  const filled = await updateGrantDocumentDraft({
    draftId: regenerated.draft.id,
    access,
    filledFields: {
      ...regenerated.draft.filledFields,
      "제품/서비스 설명": "문항 단위 자동채움 편집 검증 값",
      "이번 지원으로 달성할 목표": "검증 자동화를 통해 신청 준비 시간을 줄입니다.",
    },
  });
  if (filled.filledFields["제품/서비스 설명"] !== "문항 단위 자동채움 편집 검증 값") {
    throw new Error("자동채움 편집값이 저장되지 않았습니다.");
  }
  if (filled.missingFields.some((field) => field.label === "제품/서비스 설명")) {
    throw new Error("저장된 자동채움 값이 누락 필드에서 제거되지 않았습니다.");
  }
  const updated = await updateGrantDocumentDraft({
    draftId: filled.id,
    access,
    draftMarkdown: `${filled.draftMarkdown}\n\n검증 메모: 저장 API 확인`,
    filledFields: filled.filledFields,
    status: "reviewed",
  });
  const sectionTitle = firstDraftSectionTitle(updated.draftMarkdown);
  const sectionRegenerated = await regenerateGrantDocumentDraftSection({
    draftId: updated.id,
    access,
    request: {
      sectionTitle,
      draftMarkdown: updated.draftMarkdown,
      filledFields: updated.filledFields,
      answers: {
        "제품/서비스 설명": "섹션 재생성 검증용 제품 설명",
        "이번 지원으로 달성할 목표": "선택 섹션만 다시 생성해 기존 편집본을 보존합니다.",
      },
    },
  });
  if (sectionRegenerated.id !== updated.id || !sectionRegenerated.draftMarkdown.includes(`## ${sectionTitle}`)) {
    throw new Error("섹션별 재생성이 기존 초안을 갱신하지 못했습니다.");
  }
  const eventCount = await countDraftEvents(updated.id);
  if (eventCount < 4) {
    throw new Error(`초안 이벤트가 부족합니다: ${eventCount}`);
  }
  const feedback = await submitGrantDocumentDraftFeedback({
    draftId: sectionRegenerated.id,
    access,
    request: {
      kind: "too_generic",
      message: "품질 피드백 이벤트 저장 검증",
      fieldLabel: "사업 개요",
    },
  });
  if (feedback.draftId !== sectionRegenerated.id || !feedback.eventId) {
    throw new Error("초안 품질 피드백 응답이 올바르지 않습니다.");
  }
  const qualityFeedbackCount = await countQualityFeedbackEvents(sectionRegenerated.id);
  if (qualityFeedbackCount < 1) {
    throw new Error("초안 품질 피드백 이벤트가 저장되지 않았습니다.");
  }
  const exported = await recordGrantDocumentDraftExport({
    draftId: sectionRegenerated.id,
    access,
    format: "pdf",
  });
  if (exported.status !== "exported") {
    throw new Error(`초안 export 상태가 저장되지 않았습니다: ${exported.status}`);
  }
  const exportedEventCount = await countDraftEventsByName(sectionRegenerated.id, "exported");
  if (exportedEventCount < 1) {
    throw new Error("초안 export 이벤트가 저장되지 않았습니다.");
  }

  await deleteDraft(sectionRegenerated.id);

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "draftable_grant_selection",
      "draft_create_persistence",
      "draft_regenerate_updates_existing",
      "draft_filled_fields_update",
      "draft_missing_fields_resolution",
      "draft_update_persistence",
      "draft_section_regenerate_persistence",
      "draft_event_persistence",
      "draft_quality_feedback_event",
      "draft_export_event",
      "draft_cleanup",
    ],
    grantId: selected.grantId,
    grantTitle: selected.title,
    documentName: selected.documentName,
    status: exported.status,
    missingFields: exported.missingFields.length,
    warnings: exported.warnings.length,
    eventCount: eventCount + qualityFeedbackCount + exportedEventCount,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

async function findDraftableGrant(): Promise<{
  grantId: string;
  title: string;
  documentKey: string;
  documentName: string;
}> {
  const grants = await loadServiceGrants({ limit: 80 });
  for (const entry of grants) {
    const grantId = entry.grant.id;
    if (!grantId) continue;
    const sheet = await loadServiceApplySheet(grantId, {
      companyId: access.companyId,
      userId: access.userId,
      limit: 80,
    });
    if (!sheet || !isUuid(sheet.grant.id)) continue;
    const document = await findUnusedDraftableDocument(sheet.grant.id, sheet.applicationPrep.draftableDocuments);
    if (!document) continue;
    return {
      grantId: sheet.grant.id,
      title: sheet.grant.title,
      documentKey: document.documentKey,
      documentName: document.canonicalName,
    };
  }
  throw new Error("초안 작성 가능한 저장 공고를 찾지 못했습니다.");
}

async function findUnusedDraftableDocument(
  grantId: string,
  documents: Array<{ documentKey: string; canonicalName: string }>,
) {
  for (const document of documents) {
    if (!(await hasExistingDraft(grantId, document.documentKey))) return document;
  }
  return null;
}

async function hasExistingDraft(grantId: string, documentKey: string): Promise<boolean> {
  const db = getCunoteDb();
  const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
    .select({ id: schema.grantDocumentDrafts.id })
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.grantId, grantId),
      eq(schema.grantDocumentDrafts.companyId, access.companyId),
      eq(schema.grantDocumentDrafts.documentKey, documentKey),
    ))
    .limit(1));
  return rows.length > 0;
}

async function countDraftEvents(draftId: string): Promise<number> {
  const db = getCunoteDb();
  const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
    .select({ id: schema.grantDocumentDraftEvents.id })
    .from(schema.grantDocumentDraftEvents)
    .where(eq(schema.grantDocumentDraftEvents.draftId, draftId)));
  return rows.length;
}

async function countQualityFeedbackEvents(draftId: string): Promise<number> {
  return countDraftEventsByName(draftId, "quality_feedback");
}

async function countDraftEventsByName(draftId: string, event: string): Promise<number> {
  const db = getCunoteDb();
  const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
    .select({ id: schema.grantDocumentDraftEvents.id })
    .from(schema.grantDocumentDraftEvents)
    .where(and(
      eq(schema.grantDocumentDraftEvents.draftId, draftId),
      eq(schema.grantDocumentDraftEvents.event, event),
    )));
  return rows.length;
}

async function deleteDraft(draftId: string): Promise<void> {
  const db = getCunoteDb();
  await withCunoteDbUser(db, access.userId, async (tx) => {
    await tx
      .delete(schema.grantDocumentDrafts)
      .where(eq(schema.grantDocumentDrafts.id, draftId));
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function firstDraftSectionTitle(markdown: string): string {
  const match = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => /^##\s+(.+?)\s*$/.exec(line.trim()))
    .find((candidate): candidate is RegExpExecArray => Boolean(candidate));
  if (!match?.[1]) throw new Error("재생성할 초안 섹션을 찾지 못했습니다.");
  return match[1].trim();
}

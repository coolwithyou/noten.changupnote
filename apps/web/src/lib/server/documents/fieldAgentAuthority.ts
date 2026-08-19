import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDocumentAgentCore } from "../rhwp/documentAgentCore";
import { answerKey } from "@/features/apply-workspace/fieldAnswerState";
import { buildChoiceCellReplacement, extractFieldOptions } from "@/lib/documents/fieldOptions";
import { collectStudioFieldEvidence } from "@/lib/rhwp/studioFieldAgentTransaction";
import { resolveStudioFieldBindings } from "@/lib/rhwp/studioFieldBindings";
import type { StudioFieldTargetV1 } from "@/lib/rhwp/studioDocumentAgentProtocol";
import { isLlmSuggestableLabel } from "./fieldSuggest";
import { resolveFieldAnswers, type DraftFieldAnswer } from "./fieldAnswers";
import { loadConnectedDocumentFields, resolveArchiveStorageKey } from "./documentFieldLink";
import { getDraftRevisionHead, loadExactDraftRevisionFile } from "./documentRevisions";

export class FieldAgentAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "FieldAgentAuthorityError";
  }
}

/** client target을 권위값으로 쓰지 않고 최신 immutable revision에서 exact field binding을 재구축한다. */
export async function rebuildFieldAgentAuthority(input: {
  draftId: string;
  fieldId: string;
  baseRevisionId: string;
  requestedTarget: StudioFieldTargetV1;
  access: CompanyAccess;
}) {
  const db = getCunoteDb();
  const [draft] = await db
    .select({
      grantId: schema.grantDocumentDrafts.grantId,
      surfaceId: schema.grantDocumentDrafts.surfaceId,
      sourceAttachment: schema.grantDocumentDrafts.sourceAttachment,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      fieldAnswers: schema.grantDocumentDrafts.fieldAnswers,
      filledFields: schema.grantDocumentDrafts.filledFields,
    })
    .from(schema.grantDocumentDrafts)
    .innerJoin(schema.grants, eq(schema.grantDocumentDrafts.grantId, schema.grants.id))
    .where(and(
      eq(schema.grantDocumentDrafts.id, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .limit(1);
  if (!draft) throw new FieldAgentAuthorityError("draft_not_found", "문서 초안을 찾지 못했습니다.", 404);

  const head = await getDraftRevisionHead(input.draftId);
  if (!head || head.revisionId !== input.baseRevisionId) {
    throw new FieldAgentAuthorityError("revision_conflict", "필드 제안 기준 문서가 최신 작업본이 아닙니다.", 409);
  }
  const revision = await loadExactDraftRevisionFile({
    draftId: input.draftId,
    revisionId: input.baseRevisionId,
    access: input.access,
    requireCreator: true,
  });
  const archive = !draft.surfaceId && draft.sourceAttachment
    ? await resolveArchiveStorageKey({
        source: draft.source,
        sourceId: draft.sourceId,
        filename: draft.sourceAttachment,
      })
    : null;
  const fields = await loadConnectedDocumentFields({
    source: draft.source,
    sourceId: draft.sourceId,
    ...(draft.surfaceId ? { surfaceId: draft.surfaceId } : {}),
    ...(!draft.surfaceId && archive?.storageKey ? { sourceAttachment: archive.storageKey } : {}),
  });
  const field = fields.find((entry) => entry.fieldId === input.fieldId);
  if (!field) throw new FieldAgentAuthorityError("field_not_found", "현재 문서의 필드를 찾지 못했습니다.", 404);
  const options = extractFieldOptions(field.fieldType, field.sourceSpan);
  if (!isSupportedField(field.fieldType, options) || !isLlmSuggestableLabel(field.label)) {
    throw new FieldAgentAuthorityError("field_unsupported", "이 필드는 현재 자동 입력 대상이 아닙니다.", 409);
  }

  const rhwp = await loadDocumentAgentCore();
  const document = new rhwp.HwpDocument(revision.body);
  let target: StudioFieldTargetV1;
  try {
    if (document.pageCount() !== revision.pageCount) {
      throw new FieldAgentAuthorityError("revision_page_count_mismatch", "필드 기준 문서의 페이지 수가 다릅니다.", 409);
    }
    const resolution = resolveStudioFieldBindings(document, [field])[0];
    if (!resolution || resolution.status !== "unique") {
      throw new FieldAgentAuthorityError(
        resolution?.status === "ambiguous" ? "field_binding_ambiguous" : "field_binding_missing",
        "현재 revision에서 필드 입력 위치를 하나로 확정하지 못했습니다.",
        409,
      );
    }
    target = resolution.target;
  } finally {
    document.free();
  }
  if (!sameTarget(target, input.requestedTarget)) {
    throw new FieldAgentAuthorityError("field_binding_mismatch", "요청한 필드 위치가 서버 binding과 다릅니다.", 409);
  }
  const evidence = await collectStudioFieldEvidence(rhwp, revision.body, target);
  if (options.length > 0) {
    try {
      for (const option of options) {
        if (buildChoiceCellReplacement(evidence.text, option) === null) {
          throw new Error("choice markers missing");
        }
      }
    } catch {
      throw new FieldAgentAuthorityError(
        "field_binding_choice_mismatch",
        "현재 revision의 선택지와 필드 계획이 일치하지 않습니다.",
        409,
      );
    }
  }
  const answers = resolveFieldAnswers(draft);
  const beforeAnswer = answers[answerKey(field.label)] as DraftFieldAnswer | undefined;
  const fieldBindingSha256 = sha256(stableJson({
    schemaVersion: "field-binding-v1",
    draftId: input.draftId,
    fieldId: field.fieldId,
    revisionId: revision.revisionId,
    documentSha256: revision.sha256,
    target,
    beforeTextSha256: evidence.textSha256,
    formatSha256: evidence.formatSha256,
    adjacentContextSha256: evidence.adjacentContextSha256,
    options,
  }));
  return {
    draft,
    revision,
    field,
    target,
    evidence,
    beforeAnswer: beforeAnswer ?? null,
    options,
    fieldBindingSha256,
  };
}

function isSupportedField(fieldType: string, options: readonly string[]): boolean {
  if (options.length > 0) return true;
  const normalized = fieldType.trim().toLocaleLowerCase("en-US");
  return !["file", "table", "checkbox", "radio", "select", "long_text"].includes(normalized);
}

function sameTarget(left: StudioFieldTargetV1, right: StudioFieldTargetV1): boolean {
  if (left.kind !== right.kind || left.section !== right.section) return false;
  if (left.kind === "form_text" && right.kind === "form_text") {
    return left.paragraph === right.paragraph && left.fieldId === right.fieldId;
  }
  if (left.kind === "table_cell_text" && right.kind === "table_cell_text") {
    return left.parentPara === right.parentPara
      && left.controlIndex === right.controlIndex
      && left.cellIndex === right.cellIndex
      && left.cellParagraph === right.cellParagraph;
  }
  return false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

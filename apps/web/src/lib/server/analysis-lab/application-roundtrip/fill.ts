import { createHash } from "node:crypto";
import {
  blocksToMarkdown,
  diffBlocks,
  fillFormFields,
  parse,
  patchHwp,
  patchHwpx,
  type IRBlock,
} from "kordoc";
import type {
  RoundtripChoiceGroup,
  RoundtripChoiceVerification,
  RoundtripFieldCandidate,
  RoundtripFieldVerification,
  RoundtripFillResult,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import {
  buildRoundtripFillValues,
  extractLocatedRoundtripFields,
} from "./core";
import {
  applyContextualEdits,
  prepareContextualEdits,
  type ContextualEditRequest,
} from "./editable-regions";
import {
  buildRoundtripFillId,
  readRoundtripRunArtifacts,
  saveRoundtripFill,
} from "./store";
import {
  extractHwpFormChoiceGroups,
  patchHwpFormChoices,
} from "./hwp-form-controls";
import { finalizeHwpRoundtrip } from "./hwp-integrity";

const MAX_SUBMITTED_FIELDS = 500;
const MAX_FIELD_VALUE_CHARS = 5_000;
const MAX_SUBMITTED_CHOICE_GROUPS = 100;
const MAX_OPTIONS_PER_GROUP = 50;

export class ApplicationRoundtripFillError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ApplicationRoundtripFillError";
  }
}

export async function fillApplicationRoundtrip(input: {
  grantId: string;
  runId: string;
  attachmentId: string;
  values: Record<string, string>;
  choices?: Record<string, string[]>;
  fieldChoices?: Record<string, string[]>;
}): Promise<RoundtripFillResult> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const artifacts = await readRoundtripRunArtifacts(input.grantId, input.runId);
  if (!artifacts) throw new ApplicationRoundtripFillError("run_not_found", "왕복 분석 런을 찾지 못했습니다.", 404);
  const document = artifacts.run.documents.find((item) => item.attachmentId === input.attachmentId);
  const manifestAttachment = artifacts.manifest.attachments.find((item) => item.attachmentId === input.attachmentId);
  if (!document || !manifestAttachment) {
    throw new ApplicationRoundtripFillError("attachment_not_found", "선택한 분석 문서를 찾지 못했습니다.", 404);
  }
  if (document.error) {
    throw new ApplicationRoundtripFillError("attachment_parse_failed", "파싱에 실패한 문서는 채울 수 없습니다.", 409);
  }
  validateSubmittedValues(input.values, document.fields);
  validateSubmittedFieldChoices(input.fieldChoices ?? {}, document.fields);
  const kordocFields = document.fields.filter((field) => field.source === "kordoc-form");
  const prepared = buildRoundtripFillValues(kordocFields, input.values);
  const contextualEdits = prepareContextualEdits(document.fields, input.values, input.fieldChoices ?? {});
  const preparedChoices = prepareRoundtripChoices(document.choiceGroups ?? [], input.choices ?? {});
  if (prepared.requested.length === 0 && contextualEdits.length === 0 && preparedChoices.length === 0) {
    throw new ApplicationRoundtripFillError("no_changed_values", "원본과 다른 텍스트 또는 객관식 입력값이 없습니다.");
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new ApplicationRoundtripFillError("storage_not_configured", "R2 환경 설정이 없습니다.", 503);
  const originalObject = await storage.getObjectBytes(manifestAttachment.storageKey);
  const actualSha256 = createHash("sha256").update(originalObject.body).digest("hex");
  if (actualSha256 !== manifestAttachment.sourceSha256) {
    throw new ApplicationRoundtripFillError(
      "source_changed",
      "분석 뒤 보관 원본 바이트가 달라졌습니다. 새 분석 런을 만든 뒤 다시 시도해 주세요.",
      409,
    );
  }
  const originalParsed = await parse(originalObject.body);
  if (!originalParsed.success) {
    throw new ApplicationRoundtripFillError("source_reparse_failed", `원본 재파싱 실패: ${originalParsed.error}`, 422);
  }

  let output: Uint8Array;
  let fillMode: RoundtripFillResult["fillMode"];
  let kordocFilledCount = 0;
  let unmatchedLabels: string[] = [];
  let patchApplied: number | null = null;
  let patchSkipped: RoundtripFillResult["patchSkipped"] = [];
  let formControlPatchedCount = 0;
  let nativeChoiceWarnings: string[] = [];
  let hwpIntegrity: RoundtripFillResult["hwpIntegrity"] = null;
  const hasTextEdits = prepared.requested.length > 0 || contextualEdits.length > 0;

  const filledIr = prepared.requested.length > 0
    ? fillFormFields(originalParsed.blocks, prepared.values)
    : { blocks: structuredClone(originalParsed.blocks), filled: [], unmatched: [] };
  applyContextualEdits(filledIr.blocks, contextualEdits);
  kordocFilledCount = filledIr.filled.length;
  unmatchedLabels = filledIr.unmatched;

  if (manifestAttachment.detectedFormat === "hwpx") {
    if (preparedChoices.length > 0) {
      throw new ApplicationRoundtripFillError(
        "unsupported_hwpx_form_control",
        "이 분석 런의 객관식은 HWP 네이티브 양식 개체로만 저장할 수 있습니다.",
        422,
      );
    }
    if (!hasTextEdits) {
      output = new Uint8Array(originalObject.body);
      fillMode = "hwpx-preserve";
    } else {
      const patched = await patchHwpx(
        new Uint8Array(originalObject.body),
        blocksToMarkdown(filledIr.blocks),
        { verify: true },
      );
      if (!patched.success || !patched.data) {
        throw new ApplicationRoundtripFillError(
          "hwpx_patch_failed",
          `Kordoc HWPX 패치 실패: ${patched.error ?? "원인 미상"}`,
          422,
        );
      }
      output = patched.data;
      fillMode = "hwpx-markdown-patch";
      patchApplied = patched.applied;
      patchSkipped = patched.skipped;
    }
  } else {
    output = new Uint8Array(originalObject.body);
    fillMode = "hwp-form-controls";
    if (hasTextEdits) {
      const intendedMarkdown = blocksToMarkdown(filledIr.blocks);
      const patched = await patchHwp(originalObject.body, intendedMarkdown, { verify: true });
      if (!patched.success || !patched.data) {
        throw new ApplicationRoundtripFillError(
          "hwp_patch_failed",
          `Kordoc HWP 바이너리 패치 실패: ${patched.error ?? "원인 미상"}`,
          422,
        );
      }
      output = patched.data;
      fillMode = "hwp-binary-patch";
      patchApplied = patched.applied;
      patchSkipped = patched.skipped;
    }
    if (preparedChoices.length > 0) {
      try {
        const choicePatch = patchHwpFormChoices(
          output,
          manifestAttachment.sourceSha256,
          Object.fromEntries(preparedChoices.map(({ group, optionIds }) => [group.groupId, optionIds])),
        );
        output = choicePatch.data;
        formControlPatchedCount = choicePatch.formControlPatchedCount;
        nativeChoiceWarnings = choicePatch.warnings;
        fillMode = hasTextEdits
          ? "hwp-binary-patch+form-controls"
          : "hwp-form-controls";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ApplicationRoundtripFillError(
          "hwp_form_control_patch_failed",
          `HWP 객관식 저장 실패: ${message}`,
          422,
        );
      }
    }
    try {
      const finalized = finalizeHwpRoundtrip(originalObject.body, output);
      output = finalized.data;
      hwpIntegrity = {
        repairedLineSegmentParagraphs: finalized.repairedLineSegmentParagraphs,
        validatedParagraphs: finalized.validatedParagraphs,
        baselineIssueCount: finalized.baselineIssueCount,
        finalIssueCount: finalized.finalIssueCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApplicationRoundtripFillError(
        "hwp_integrity_failed",
        `HWP 저장본 무결성 검사 실패: ${message}`,
        422,
      );
    }
  }

  const outputParsed = await parse(Buffer.from(output));
  if (!outputParsed.success) {
    throw new ApplicationRoundtripFillError("output_reparse_failed", `저장본 재파싱 실패: ${outputParsed.error}`, 422);
  }
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  const outputFields = extractLocatedRoundtripFields(outputParsed.blocks, outputSha256).fields;
  const fieldVerifications = [
    ...verifyRoundtripFields(prepared.requested, outputFields, outputParsed.blocks),
    ...verifyContextualEdits(contextualEdits, outputParsed.blocks),
  ];
  const verifiedFieldCount = fieldVerifications.filter((item) => item.status === "matched").length;
  const outputChoiceGroups = preparedChoices.length > 0
    ? extractHwpFormChoiceGroups(output, manifestAttachment.sourceSha256)
    : [];
  const choiceVerifications = verifyRoundtripChoices(preparedChoices, outputChoiceGroups);
  const verifiedChoiceGroupCount = choiceVerifications.filter((item) => item.status === "matched").length;
  const requestedTextFieldCount = prepared.requested.length + contextualEdits.length;
  const allVerified = verifiedFieldCount === requestedTextFieldCount
    && verifiedChoiceGroupCount === preparedChoices.length;
  const diff = diffBlocks(originalParsed.blocks, outputParsed.blocks).stats;
  const fillId = buildRoundtripFillId(startedAt);
  const extension = manifestAttachment.detectedFormat;
  const filenameBase = manifestAttachment.filename.replace(/\.(?:hwp|hwpx)$/i, "");
  const outputFilename = `${sanitizeDownloadFilename(filenameBase, "application")}-샘플채움-${fillId.slice(-6)}.${extension}`;
  const warnings: string[] = [...nativeChoiceWarnings];
  if (unmatchedLabels.length > 0) warnings.push(`Kordoc 미매칭 라벨 ${unmatchedLabels.length}개`);
  if (patchSkipped.length > 0) warnings.push(`HWP 안전 게이트로 건너뛴 패치 ${patchSkipped.length}개`);
  if (verifiedFieldCount !== requestedTextFieldCount) {
    warnings.push(`텍스트 요청 ${requestedTextFieldCount}개 중 ${verifiedFieldCount}개만 재파싱 검증됨`);
  }
  if (verifiedChoiceGroupCount !== preparedChoices.length) {
    warnings.push(`객관식 요청 ${preparedChoices.length}개 중 ${verifiedChoiceGroupCount}개만 재파싱 검증됨`);
  }
  if ((hwpIntegrity?.repairedLineSegmentParagraphs ?? 0) > 0) {
    warnings.push(`HWP 줄 배치 캐시 ${hwpIntegrity!.repairedLineSegmentParagraphs}개 문단 자동 보정`);
  }

  const downloadParams = new URLSearchParams({
    grantId: input.grantId,
    runId: input.runId,
    fillId,
  });
  const result: RoundtripFillResult = {
    fillId,
    runId: input.runId,
    grantId: input.grantId,
    attachmentId: input.attachmentId,
    sourceFilename: manifestAttachment.filename,
    outputFilename,
    outputFormat: extension,
    fillMode,
    createdAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    requestedFieldCount: requestedTextFieldCount,
    kordocFilledCount,
    verifiedFieldCount,
    requestedChoiceGroupCount: preparedChoices.length,
    formControlPatchedCount,
    verifiedChoiceGroupCount,
    hwpIntegrity,
    allVerified,
    unmatchedLabels,
    patchApplied,
    patchSkipped,
    documentDiff: diff,
    fieldVerifications,
    choiceVerifications,
    warnings,
    downloadUrl: `/api/dev/analysis-lab/application-roundtrip/download?${downloadParams.toString()}`,
  };
  await saveRoundtripFill({
    runDir: artifacts.dir,
    result,
    request: {
      attachmentId: input.attachmentId,
      sourceSha256: actualSha256,
      values: Object.fromEntries(prepared.requested.map(({ field, value }) => [field.fieldInstanceId, value])),
      contextualValues: Object.fromEntries(contextualEdits.map(({ field, inputValue }) => [field.fieldInstanceId, inputValue])),
      fieldChoices: Object.fromEntries(contextualEdits
        .filter((edit) => edit.selectedOptionIds.length > 0)
        .map(({ field, selectedOptionIds }) => [field.fieldInstanceId, selectedOptionIds])),
      choices: Object.fromEntries(preparedChoices.map(({ group, optionIds }) => [group.groupId, optionIds])),
    },
    output,
  });
  return result;
}

function prepareRoundtripChoices(
  groups: RoundtripChoiceGroup[],
  choices: Record<string, string[]>,
): Array<{ group: RoundtripChoiceGroup; optionIds: string[] }> {
  const entries = Object.entries(choices);
  if (entries.length > MAX_SUBMITTED_CHOICE_GROUPS) {
    throw new ApplicationRoundtripFillError(
      "too_many_choice_groups",
      `한 번에 ${MAX_SUBMITTED_CHOICE_GROUPS}개 객관식 그룹까지만 저장할 수 있습니다.`,
    );
  }
  const knownGroups = new Map(groups.map((group) => [group.groupId, group]));
  const requested: Array<{ group: RoundtripChoiceGroup; optionIds: string[] }> = [];
  for (const [groupId, optionIds] of entries) {
    const group = knownGroups.get(groupId);
    if (!group) throw new ApplicationRoundtripFillError("unknown_choice_group", `런에 없는 객관식 그룹입니다: ${groupId}`);
    if (!Array.isArray(optionIds) || optionIds.some((optionId) => typeof optionId !== "string")) {
      throw new ApplicationRoundtripFillError("invalid_choice_value", "객관식 값은 optionId 문자열 배열이어야 합니다.");
    }
    if (optionIds.length > MAX_OPTIONS_PER_GROUP) {
      throw new ApplicationRoundtripFillError(
        "too_many_choice_options",
        `한 그룹에서 ${MAX_OPTIONS_PER_GROUP}개까지만 선택할 수 있습니다.`,
      );
    }
    const uniqueIds = new Set(optionIds);
    if (uniqueIds.size !== optionIds.length) {
      throw new ApplicationRoundtripFillError("duplicate_choice_option", `중복된 객관식 선택값이 있습니다: ${group.label}`);
    }
    const allowedIds = new Set(group.options.map((option) => option.optionId));
    for (const optionId of uniqueIds) {
      if (!allowedIds.has(optionId)) {
        throw new ApplicationRoundtripFillError("unknown_choice_option", `런에 없는 선택지입니다: ${group.label}`);
      }
    }
    if (group.selectionMode === "single" && uniqueIds.size !== 1) {
      throw new ApplicationRoundtripFillError("single_choice_required", `“${group.label}”은 하나만 선택해야 합니다.`);
    }
    const canonicalIds = group.options
      .filter((option) => uniqueIds.has(option.optionId))
      .map((option) => option.optionId);
    const originalIds = group.options.filter((option) => option.selected).map((option) => option.optionId);
    if (!sameStringArray(canonicalIds, originalIds)) requested.push({ group, optionIds: canonicalIds });
  }
  return requested;
}

function validateSubmittedValues(
  values: Record<string, string>,
  fields: RoundtripFieldCandidate[],
): void {
  const entries = Object.entries(values);
  if (entries.length > MAX_SUBMITTED_FIELDS) {
    throw new ApplicationRoundtripFillError("too_many_fields", `한 번에 ${MAX_SUBMITTED_FIELDS}개까지만 채울 수 있습니다.`);
  }
  const allowed = new Set(fields.map((field) => field.fieldInstanceId));
  for (const [fieldId, value] of entries) {
    if (!allowed.has(fieldId)) throw new ApplicationRoundtripFillError("unknown_field", `런에 없는 필드입니다: ${fieldId}`);
    if (typeof value !== "string") throw new ApplicationRoundtripFillError("invalid_field_value", "필드 값은 문자열이어야 합니다.");
    if (value.length > MAX_FIELD_VALUE_CHARS) {
      throw new ApplicationRoundtripFillError("field_value_too_long", `필드 값은 ${MAX_FIELD_VALUE_CHARS}자를 넘을 수 없습니다.`);
    }
  }
}

function validateSubmittedFieldChoices(
  choices: Record<string, string[]>,
  fields: RoundtripFieldCandidate[],
): void {
  const entries = Object.entries(choices);
  if (entries.length > MAX_SUBMITTED_FIELDS) {
    throw new ApplicationRoundtripFillError("too_many_field_choices", `한 번에 ${MAX_SUBMITTED_FIELDS}개 객관식 필드까지만 저장할 수 있습니다.`);
  }
  const known = new Map(fields.map((field) => [field.fieldInstanceId, field]));
  for (const [fieldId, optionIds] of entries) {
    const field = known.get(fieldId);
    if (!field || field.source !== "contextual-region" || field.options.length === 0) {
      throw new ApplicationRoundtripFillError("unknown_field_choice", `런에 없는 맥락 객관식 필드입니다: ${fieldId}`);
    }
    if (!Array.isArray(optionIds) || optionIds.some((optionId) => typeof optionId !== "string")) {
      throw new ApplicationRoundtripFillError("invalid_field_choice", "맥락 객관식 값은 optionId 문자열 배열이어야 합니다.");
    }
    if (optionIds.length > MAX_OPTIONS_PER_GROUP || new Set(optionIds).size !== optionIds.length) {
      throw new ApplicationRoundtripFillError("invalid_field_choice", `선택지 수 또는 중복 값이 올바르지 않습니다: ${field.label}`);
    }
    const allowed = new Set(field.options.map((option) => option.optionId));
    if (optionIds.some((optionId) => !allowed.has(optionId))) {
      throw new ApplicationRoundtripFillError("unknown_field_choice_option", `런에 없는 선택지입니다: ${field.label}`);
    }
    if (field.inputKind === "single_choice" && optionIds.length !== 1) {
      throw new ApplicationRoundtripFillError("single_field_choice_required", `“${field.label}”은 하나만 선택해야 합니다.`);
    }
  }
}

function verifyRoundtripFields(
  requested: Array<{ field: RoundtripFieldCandidate; value: string }>,
  after: RoundtripFieldCandidate[],
  blocks: IRBlock[],
): RoundtripFieldVerification[] {
  return requested.map(({ field, value }) => {
    const block = blocks[field.location.blockIndex];
    const row = block?.type === "table" ? block.table?.cells[field.location.row] : undefined;
    const expected = value.trim();
    const valueAtSourceRow = row?.some((cell) => cell.text.includes(expected)) ?? false;
    const match = after.find((candidate) =>
      candidate.normalizedLabel === field.normalizedLabel
      && candidate.location.occurrence === field.location.occurrence
      && candidate.location.blockIndex === field.location.blockIndex);
    const actualValue = valueAtSourceRow ? expected : match?.originalValue.trim() ?? null;
    return {
      fieldInstanceId: field.fieldInstanceId,
      label: field.label,
      occurrence: field.location.occurrence,
      expectedValue: value,
      actualValue,
      status: actualValue === null
        ? "missing_after_fill"
        : actualValue === value.trim()
          ? "matched"
          : "mismatch",
    };
  });
}

function verifyContextualEdits(
  edits: ContextualEditRequest[],
  blocks: IRBlock[],
): RoundtripFieldVerification[] {
  return edits.map((edit) => {
    const target = edit.field.location.target!;
    const block = blocks[edit.field.location.blockIndex];
    const current = target.kind === "block_text"
      ? block?.text ?? null
      : block?.type === "table" && target.row !== null && target.col !== null
        ? block.table?.cells[target.row]?.[target.col]?.text ?? null
        : null;
    const matched = current !== null && (edit.field.writeOperation === "toggle_text_choice"
      ? verifyTextChoiceMarkers(current, edit)
      : edit.documentValue.length > 0
        ? current.includes(edit.documentValue)
        : !current.includes(target.expectedText));
    const expectedValue = edit.inputValue || edit.documentValue;
    return {
      fieldInstanceId: edit.field.fieldInstanceId,
      label: edit.field.label,
      occurrence: edit.field.location.occurrence,
      expectedValue,
      actualValue: matched ? expectedValue : current,
      status: current === null ? "missing_after_fill" : matched ? "matched" : "mismatch",
    };
  });
}

function verifyTextChoiceMarkers(current: string, edit: ContextualEditRequest): boolean {
  const markers = [...current.matchAll(/[□■☐☑☒✓]/g)].map((match) => match[0]);
  if (markers.length < edit.field.options.length) return false;
  const selectedMarkers = new Set(["■", "☑", "☒", "✓"]);
  return edit.field.options.every((option, index) =>
    selectedMarkers.has(markers[index]!) === edit.selectedOptionIds.includes(option.optionId));
}

function verifyRoundtripChoices(
  requested: Array<{ group: RoundtripChoiceGroup; optionIds: string[] }>,
  after: RoundtripChoiceGroup[],
): RoundtripChoiceVerification[] {
  return requested.map(({ group, optionIds }) => {
    const actualGroup = after.find((candidate) => candidate.groupId === group.groupId);
    const actualOptionIds = actualGroup
      ? actualGroup.options.filter((option) => option.selected).map((option) => option.optionId)
      : null;
    return {
      groupId: group.groupId,
      label: group.label,
      expectedOptionIds: optionIds,
      actualOptionIds,
      status: actualOptionIds === null
        ? "missing_after_fill"
        : sameStringArray(optionIds, actualOptionIds)
          ? "matched"
          : "mismatch",
    };
  });
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

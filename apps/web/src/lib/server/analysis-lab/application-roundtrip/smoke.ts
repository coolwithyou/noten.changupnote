/**
 * 실데이터 왕복 smoke (DB/R2 read-only, 파일시스템 spike-out write-only).
 *
 * 실행:
 *   pnpm lab:roundtrip:smoke -- --grant-id <uuid>
 * grant-id를 생략하면 파일명 기준 지원서 후보가 있는 첫 공고를 사용한다.
 */
import { loadApplicationRoundtripCohort } from "./cohort";
import { runApplicationRoundtripAnalysis } from "./analyze";
import { fillApplicationRoundtrip } from "./fill";

const requestedGrantId = argument("--grant-id");

try {
  const cohort = requestedGrantId ? null : await loadApplicationRoundtripCohort();
  const grantId = requestedGrantId ?? cohort?.notices.find(
    (notice) => notice.likelyApplicationDocumentCount > 0,
  )?.grantId;
  if (!grantId) throw new Error("왕복 smoke 대상 공고를 찾지 못했습니다.");

  const run = await runApplicationRoundtripAnalysis(grantId);
  const document = run.documents.find((item) => item.attachmentId === run.recommendedAttachmentId);
  if (!document) throw new Error(`빈 필드가 있는 추천 문서가 없습니다: ${run.recommendationReason}`);
  const fields = selectSmokeFields(document.fields.filter((field) => field.recommendedInput));
  const choiceGroups = document.choiceGroups ?? [];
  if (fields.length === 0 && choiceGroups.length === 0) throw new Error("추천 문서에 채울 입력 대상이 없습니다.");
  const values = Object.fromEntries(fields
    .filter((field) => field.inputKind !== "single_choice" && field.inputKind !== "multiple_choice")
    .map((field) => [field.fieldInstanceId, field.sampleValue]));
  const fieldChoices = Object.fromEntries(fields
    .filter((field) => field.options.length > 0)
    .map((field) => {
      const selected = field.options.filter((option) => option.selected).map((option) => option.optionId);
      const fallback = field.inputKind === "multiple_choice"
        ? field.options.slice(0, 2).map((option) => option.optionId)
        : field.options[0] ? [field.options[0].optionId] : [];
      return [field.fieldInstanceId, selected.length > 0 ? selected : fallback];
    }));
  const choices = Object.fromEntries(choiceGroups.flatMap((group) => {
    const current = group.options.filter((option) => option.selected).map((option) => option.optionId);
    const sample = current.length > 0 ? current : group.options[0] ? [group.options[0].optionId] : [];
    return sample.length > 0 ? [[group.groupId, sample]] : [];
  }));
  const fill = await fillApplicationRoundtrip({
    grantId,
    runId: run.runId,
    attachmentId: document.attachmentId,
    values,
    choices,
    fieldChoices,
  });

  console.log(JSON.stringify({
    ok: fill.allVerified,
    grantId,
    title: run.title,
    engineVersion: run.engineVersion,
    parsedDocuments: run.documents.length,
    recommendedDocument: document.filename,
    role: document.role,
    rawEmptyFields: document.emptyFieldCount,
    recommendedInputFields: document.recommendedInputFieldCount,
    fieldPlanning: document.fieldPlanning,
    requestedFields: fill.requestedFieldCount,
    verifiedFields: fill.verifiedFieldCount,
    detectedChoiceGroups: choiceGroups.length,
    requestedChoiceGroups: fill.requestedChoiceGroupCount,
    verifiedChoiceGroups: fill.verifiedChoiceGroupCount,
    patchedFormControls: fill.formControlPatchedCount,
    hwpIntegrity: fill.hwpIntegrity,
    fillMode: fill.fillMode,
    runId: run.runId,
    fillId: fill.fillId,
    outputFilename: fill.outputFilename,
    warnings: fill.warnings,
  }, null, 2));
  process.exit(fill.allVerified ? 0 : 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  return value || null;
}

function selectSmokeFields<T extends {
  fieldInstanceId: string;
  source: string;
  writeOperation: string;
  location: { target?: { kind: string } };
}>(fields: T[]): T[] {
  const selected: T[] = [];
  const add = (field: T | undefined) => {
    if (field && !selected.some((item) => item.fieldInstanceId === field.fieldInstanceId)) selected.push(field);
  };
  add(fields.find((field) => field.writeOperation === "toggle_text_choice"));
  add(fields.find((field) => field.writeOperation === "replace_span" && field.location.target?.kind === "table_cell"));
  add(fields.find((field) => field.writeOperation === "replace_instruction"));
  add(fields.find((field) => field.writeOperation === "insert_before_unit"));
  add(fields.find((field) => field.writeOperation === "replace_span" && field.location.target?.kind === "block_text"));
  add(fields.find((field) => field.source === "kordoc-form"));
  for (const field of fields) {
    if (selected.length >= 8) break;
    add(field);
  }
  return selected;
}

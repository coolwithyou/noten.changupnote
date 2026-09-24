import {
  CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
  canonicalConfirmationQuestionDraftJson,
  confirmationQuestionDraftPacketBody,
  parseConfirmationQuestionDraftPacket,
  parseConfirmationQuestionManualInputEnvelope,
  normalizedCompanyFactBoundary,
  type ConfirmationQuestionDraftEvaluation,
  type ConfirmationQuestionDraftPacket,
  type ConfirmationQuestionManualInputEnvelope,
} from "@cunote/contracts/confirmation-question-draft";

export type ConfirmationQuestionDraftDecision = "pending" | "include" | "exclude";

export interface EditableConfirmationQuestionDraftItem {
  criterionIndex: number;
  criterionKind: "required" | "preferred" | "exclusion";
  polarity: "criterion_satisfaction" | "exclusion_membership";
  criterionSha256: string;
  sourceSpan: string;
  resolutionScope: "per_notice" | "company_fact";
  conditionKey?: string;
  companyFactMeaning?: string;
  companyFactDefinitionSource?: "new_review" | "existing_reviewed";
  existingDefinition?: import("@cunote/contracts/confirmation-question-draft").CompanyFactReview["existingDefinition"];
  normalizedCriterion?: import("@cunote/contracts/confirmation-question-draft").ConfirmationQuestionDraftItem["normalizedCriterion"];
  prompt: string;
  options: Array<{
    value: "yes" | "no" | "unknown";
    label: string;
    evaluation: ConfirmationQuestionDraftEvaluation;
  }>;
  decision: ConfirmationQuestionDraftDecision;
}

export interface ImportedConfirmationQuestionDraft {
  packet: ConfirmationQuestionDraftPacket;
  fileSha256: string;
  items: EditableConfirmationQuestionDraftItem[];
  questionAuthorEmail: string;
  revisionIntent: "initial" | "replace" | "withdraw_all";
  withdrawnCriterionIndexes: number[];
}

export interface ConfirmationQuestionDraftImportGeneration {
  current: number;
}

export function beginConfirmationQuestionDraftImport(
  generation: ConfirmationQuestionDraftImportGeneration,
): { value: number; isLatest: () => boolean } {
  const value = generation.current + 1;
  generation.current = value;
  return { value, isLatest: () => generation.current === value };
}

export async function importConfirmationQuestionDraft(
  text: string,
): Promise<ImportedConfirmationQuestionDraft> {
  const raw = JSON.parse(text) as unknown;
  const envelope = raw
    && typeof raw === "object"
    && !Array.isArray(raw)
    && (raw as Record<string, unknown>).schema === CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA
    ? parseConfirmationQuestionManualInputEnvelope(raw)
    : null;
  const packet = envelope?.draftPacket ?? parseConfirmationQuestionDraftPacket(raw);
  const actualContentSha256 = await browserSha256(
    canonicalConfirmationQuestionDraftJson(confirmationQuestionDraftPacketBody(packet)),
  );
  if (actualContentSha256 !== packet.contentSha256) {
    throw new Error("packet content SHA가 내용과 일치하지 않습니다.");
  }
  const priorItems = new Map(
    envelope?.manualInput.items.map((item) => [item.criterionIndex, item]) ?? [],
  );
  return {
    packet,
    fileSha256: await browserSha256(text),
    items: packet.items.map((item) => {
      const prior = priorItems.get(item.criterionIndex);
      return {
        criterionIndex: item.criterionIndex,
        criterionKind: item.criterionKind,
        polarity: item.polarity,
        criterionSha256: item.criterionSha256,
        sourceSpan: item.sourceSpan,
        resolutionScope: prior?.resolutionScope ?? "per_notice",
        conditionKey: prior?.conditionKey ?? "",
        companyFactMeaning: prior?.companyFactReview?.meaning ?? "",
        companyFactDefinitionSource: prior?.companyFactReview?.definitionSource ?? "new_review",
        ...(prior?.companyFactReview?.existingDefinition ? {
          existingDefinition: prior.companyFactReview.existingDefinition,
        } : {}),
        prompt: prior?.prompt ?? item.prompt,
        options: (prior?.options ?? item.options).map((option) => ({ ...option })),
        decision: envelope ? (prior ? "include" : "exclude") : "pending",
      };
    }),
    questionAuthorEmail: envelope?.manualInput.questionAuthorEmail ?? "",
    revisionIntent: envelope?.manualInput.intent ?? "initial",
    withdrawnCriterionIndexes: envelope?.manualInput.withdrawnCriterionIndexes ?? [],
  };
}

export function buildManualConfirmationDraftInput(input: {
  packet: ConfirmationQuestionDraftPacket;
  questionAuthorEmail: string;
  items: readonly EditableConfirmationQuestionDraftItem[];
  revisionIntent?: "initial" | "replace" | "withdraw_all";
  withdrawnCriterionIndexes?: readonly number[];
}): ConfirmationQuestionManualInputEnvelope {
  const questionAuthorEmail = input.questionAuthorEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(questionAuthorEmail)) {
    throw new Error("질문 작성자 이메일 형식이 올바르지 않습니다.");
  }
  if (input.items.some((item) => item.decision === "pending")) {
    throw new Error("모든 후보를 포함 또는 제외로 명시 검토해주세요.");
  }
  const included = input.items.filter((item) => item.decision === "include");
  if (included.length === 0 && input.revisionIntent !== "withdraw_all") {
    throw new Error("내보낼 질문을 하나 이상 포함해주세요.");
  }
  if (input.revisionIntent === "withdraw_all" && included.length > 0) {
    throw new Error("전체 철회에는 포함 질문이 없어야 합니다.");
  }
  return parseConfirmationQuestionManualInputEnvelope({
    schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
    draftPacket: input.packet,
    manualInput: {
      questionAuthorEmail,
      ...(input.revisionIntent && input.revisionIntent !== "initial" ? {
        intent: input.revisionIntent,
        withdrawnCriterionIndexes: [...(input.withdrawnCriterionIndexes ?? [])],
      } : {}),
      items: included.map((item) => {
        const prompt = item.prompt.trim();
        if (!prompt) throw new Error(`조건 ${item.criterionIndex + 1}의 질문 문구가 비어 있습니다.`);
        const options = item.options.map((option) => {
          const label = option.label.trim();
          if (!label) throw new Error(`조건 ${item.criterionIndex + 1}의 선택지 문구가 비어 있습니다.`);
          return { ...option, label };
        });
        assertExplicitPolarity(item, options);
        return {
          criterionIndex: item.criterionIndex,
          resolutionScope: item.resolutionScope,
          ...(item.resolutionScope === "company_fact" ? { conditionKey: (item.conditionKey ?? "").trim() } : {}),
          ...(item.resolutionScope === "company_fact" ? {
            companyFactReview: buildCompanyFactReview(item, input.packet.source.reviewArtifactSha256),
          } : {}),
          prompt,
          options,
        };
      }),
    },
  });
}

function buildCompanyFactReview(
  item: EditableConfirmationQuestionDraftItem,
  reviewArtifactSha256: string,
) {
  const boundary = normalizedCompanyFactBoundary(item.normalizedCriterion?.value);
  if (!boundary) {
    throw new Error(`조건 ${item.criterionIndex + 1}은 정규화 scope/기준일이 없어 회사 사실 공유를 보류합니다. 원 criterion 검수·수정으로 되돌리세요.`);
  }
  const meaning = item.companyFactMeaning?.trim() ?? "";
  if (!meaning) throw new Error(`조건 ${item.criterionIndex + 1}의 검수된 회사 사실 의미를 입력하세요.`);
  const definitionSource = item.companyFactDefinitionSource ?? "new_review";
  if (definitionSource === "existing_reviewed" && !item.existingDefinition) {
    throw new Error(`조건 ${item.criterionIndex + 1}의 기존 정의에는 exact artifact selector가 필요합니다.`);
  }
  return {
    meaning,
    definitionKey: (item.conditionKey ?? "").trim(),
    definitionSource,
    ...(definitionSource === "existing_reviewed" ? { existingDefinition: item.existingDefinition! } : {}),
    ...boundary,
    reviewArtifactSha256,
  };
}

export function manualConfirmationDraftFilename(
  packet: ConfirmationQuestionDraftPacket,
): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe(packet.source.grantId)}-${safe(packet.source.runId)}.bound-manual-confirmation-input.json`;
}

async function browserSha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertExplicitPolarity(
  item: EditableConfirmationQuestionDraftItem,
  options: EditableConfirmationQuestionDraftItem["options"],
): void {
  const expected = item.criterionKind === "exclusion"
    ? ["unsatisfied", "satisfied", "unknown"]
    : ["satisfied", "unsatisfied", "unknown"];
  const expectedPolarity = item.criterionKind === "exclusion"
    ? "exclusion_membership"
    : "criterion_satisfaction";
  if (
    item.polarity !== expectedPolarity
    || options.length !== 3
    || options.some((option, index) =>
      option.value !== ["yes", "no", "unknown"][index]
      || option.evaluation !== expected[index])
  ) {
    throw new Error(`조건 ${item.criterionIndex + 1}의 고정 3상태 극성이 변경되었습니다.`);
  }
}

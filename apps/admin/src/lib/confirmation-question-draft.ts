import {
  CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
  canonicalConfirmationQuestionDraftJson,
  confirmationQuestionDraftPacketBody,
  parseConfirmationQuestionDraftPacket,
  parseConfirmationQuestionManualInputEnvelope,
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
        prompt: prior?.prompt ?? item.prompt,
        options: (prior?.options ?? item.options).map((option) => ({ ...option })),
        decision: envelope ? (prior ? "include" : "exclude") : "pending",
      };
    }),
    questionAuthorEmail: envelope?.manualInput.questionAuthorEmail ?? "",
  };
}

export function buildManualConfirmationDraftInput(input: {
  packet: ConfirmationQuestionDraftPacket;
  questionAuthorEmail: string;
  items: readonly EditableConfirmationQuestionDraftItem[];
}): ConfirmationQuestionManualInputEnvelope {
  const questionAuthorEmail = input.questionAuthorEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(questionAuthorEmail)) {
    throw new Error("질문 작성자 이메일 형식이 올바르지 않습니다.");
  }
  if (input.items.some((item) => item.decision === "pending")) {
    throw new Error("모든 후보를 포함 또는 제외로 명시 검토해주세요.");
  }
  const included = input.items.filter((item) => item.decision === "include");
  if (included.length === 0) throw new Error("내보낼 질문을 하나 이상 포함해주세요.");
  return parseConfirmationQuestionManualInputEnvelope({
    schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
    draftPacket: input.packet,
    manualInput: {
      questionAuthorEmail,
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
          resolutionScope: "per_notice" as const,
          prompt,
          options,
        };
      }),
    },
  });
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

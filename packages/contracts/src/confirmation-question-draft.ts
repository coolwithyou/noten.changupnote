export const CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA =
  "confirmation-question-draft-packet-v1" as const;
export const CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION =
  "deterministic-confirmation-question-draft-v1" as const;
export const CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA =
  "confirmation-question-manual-input-envelope-v1" as const;

export type ConfirmationQuestionDraftCriterionKind =
  | "required"
  | "preferred"
  | "exclusion";

export type ConfirmationQuestionDraftEvaluation =
  | "satisfied"
  | "unsatisfied"
  | "unknown";

export interface ConfirmationQuestionDraftOption {
  value: "yes" | "no" | "unknown";
  label: string;
  evaluation: ConfirmationQuestionDraftEvaluation;
}

export interface ConfirmationQuestionDraftItem {
  criterionIndex: number;
  criterionKind: ConfirmationQuestionDraftCriterionKind;
  /** 극성을 문구에서 추론하지 않도록 criterion 구조에서 확정한 해석이다. */
  polarity: "criterion_satisfaction" | "exclusion_membership";
  criterionSha256: string;
  sourceSpan: string;
  /** 새 packet의 원 criterion 정규화 값. 없는 역사 packet은 회사 사실 공유에 쓸 수 없다. */
  normalizedCriterion?: { dimension: string; kind: ConfirmationQuestionDraftCriterionKind; operator: string; value: unknown };
  resolutionScope: "per_notice";
  answerType: "single";
  prompt: string;
  options: [
    ConfirmationQuestionDraftOption,
    ConfirmationQuestionDraftOption,
    ConfirmationQuestionDraftOption,
  ];
}

export interface ConfirmationQuestionDraftPacketBody {
  schema: typeof CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA;
  generatorVersion: typeof CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION;
  authority: {
    status: "unreviewed_draft";
    modelCallsMade: 0;
    serviceDatabaseWritesMade: 0;
    releaseAuthorized: false;
    promotionAuthorized: false;
    liveQuestionWriteAuthorized: false;
    currentServiceStateVerified: false;
  };
  source: {
    grantId: string;
    runId: string;
    source: string;
    sourceId: string;
    inputSha256: string;
    sourceRevisionSha256: string;
    attachmentManifestSha256: string | null;
    runArtifactSha256: string;
    reviewArtifactSha256: string;
    criterionReviewerEmail: string;
    reviewUpdatedAt: string;
  };
  items: ConfirmationQuestionDraftItem[];
}

export interface ConfirmationQuestionDraftPacket
  extends ConfirmationQuestionDraftPacketBody {
  /** 이 필드를 제외한 canonical packet body의 SHA-256. */
  contentSha256: string;
}

export interface ManualConfirmationDraftInput {
  questionAuthorEmail: string;
  intent?: "replace" | "withdraw_all";
  withdrawnCriterionIndexes?: number[];
  items: Array<{
    criterionIndex: number;
    resolutionScope: "per_notice" | "company_fact";
    /** company_fact일 때 검수자가 확정한 표준 사실 키. */
    conditionKey?: string;
    companyFactReview?: CompanyFactReview;
    prompt: string;
    options: ConfirmationQuestionDraftOption[];
  }>;
}

/** 사람이 새 사실의 의미를 확정한 기록. scope/date는 원 criterion의 구조화 값과 정확히 같아야 한다. */
export interface CompanyFactReview {
  meaning: string;
  definitionKey: string;
  definitionSource: "new_review" | "existing_reviewed";
  existingDefinition?: {
    grantId: string;
    runId: string;
    revision: number;
    artifactSha256: string;
    criterionIndex: number;
  };
  scopeField: string;
  scopeValue: string | string[];
  asOfField: string;
  asOfDate: string;
  reviewArtifactSha256: string;
}

export function normalizedCompanyFactBoundary(value: unknown): Pick<CompanyFactReview, "scopeField" | "scopeValue" | "asOfField" | "asOfDate"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Matching identity intentionally ignores note when structured fields exist. A nonempty note
  // could hide a scope/date qualifier, so new shared facts require a fully structured value.
  if (typeof record.note === "string" && record.note.trim().length > 0) return null;
  const scopeFields = ["fact_scope", "facility_scope", "facilityTypes", "scope"]
    .filter((field) => Object.hasOwn(record, field));
  const dateFields = ["basis_date", "basisDate", "as_of_date", "asOfDate"]
    .filter((field) => Object.hasOwn(record, field));
  if (scopeFields.length !== 1 || dateFields.length !== 1) return null;
  const scopeField = scopeFields[0]!;
  const asOfField = dateFields[0]!;
  const scopeValue = record[scopeField];
  const asOfDate = record[asOfField];
  const validScope = typeof scopeValue === "string"
    ? scopeValue.trim() === scopeValue && scopeValue.length > 0
    : Array.isArray(scopeValue) && scopeValue.length > 0
      && scopeValue.every((item) => typeof item === "string" && item.trim() === item && item.length > 0)
      && new Set(scopeValue).size === scopeValue.length;
  if (!validScope || typeof asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
    || Number.isNaN(Date.parse(`${asOfDate}T00:00:00.000Z`))
    || new Date(`${asOfDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== asOfDate) return null;
  return { scopeField, scopeValue: scopeValue as string | string[], asOfField, asOfDate };
}

/**
 * 관리자 편집 결과. 원 packet 전체를 보존해 CLI가 raw run/review 및 criterion SHA를
 * 재결속하기 전에는 legacy manual input으로 해석할 수 없게 한다.
 */
export interface ConfirmationQuestionManualInputEnvelope {
  schema: typeof CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA;
  draftPacket: ConfirmationQuestionDraftPacket;
  /** 중첩해 두어 schema 오타가 있어도 legacy CLI input으로 우연히 해석되지 않게 한다. */
  manualInput: ManualConfirmationDraftInput;
}

export function parseConfirmationQuestionDraftPacket(
  raw: unknown,
): ConfirmationQuestionDraftPacket {
  const packet = record(raw, "draft packet");
  exactKeys(packet, [
    "schema",
    "generatorVersion",
    "authority",
    "source",
    "items",
    "contentSha256",
  ], "draft packet");
  if (packet.schema !== CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA) {
    throw new Error("확인질문 draft packet schema가 올바르지 않습니다.");
  }
  if (packet.generatorVersion !== CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION) {
    throw new Error("확인질문 draft generator version이 올바르지 않습니다.");
  }
  const authority = parseAuthority(packet.authority);
  const source = parseSource(packet.source);
  if (!Array.isArray(packet.items) || packet.items.length === 0) {
    throw new Error("확인질문 draft packet에는 후보가 하나 이상 필요합니다.");
  }
  const seenIndexes = new Set<number>();
  const items = packet.items.map((item, index) => {
    const parsed = parseItem(item, index);
    if (seenIndexes.has(parsed.criterionIndex)) {
      throw new Error(`확인질문 draft criterionIndex 중복: ${parsed.criterionIndex}`);
    }
    seenIndexes.add(parsed.criterionIndex);
    return parsed;
  });
  if (items.some((item, index) => index > 0 && items[index - 1]!.criterionIndex >= item.criterionIndex)) {
    throw new Error("확인질문 draft items는 criterionIndex 오름차순이어야 합니다.");
  }
  return {
    schema: CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
    generatorVersion: CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
    authority,
    source,
    items,
    contentSha256: requiredSha256(packet.contentSha256, "contentSha256"),
  };
}

export function confirmationQuestionDraftPacketBody(
  packet: ConfirmationQuestionDraftPacket,
): ConfirmationQuestionDraftPacketBody {
  const { contentSha256: _contentSha256, ...body } = packet;
  return body;
}

export function parseConfirmationQuestionManualInputEnvelope(
  raw: unknown,
): ConfirmationQuestionManualInputEnvelope {
  const envelope = record(raw, "manual input envelope");
  exactKeys(envelope, ["schema", "draftPacket", "manualInput"], "manual input envelope");
  if (envelope.schema !== CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA) {
    throw new Error("manual input envelope schema가 올바르지 않습니다.");
  }
  const draftPacket = parseConfirmationQuestionDraftPacket(envelope.draftPacket);
  const manualInput = record(envelope.manualInput, "manualInput");
  const revision = Object.hasOwn(manualInput, "intent") || Object.hasOwn(manualInput, "withdrawnCriterionIndexes");
  exactKeys(manualInput, ["questionAuthorEmail", "items", ...(revision ? ["intent", "withdrawnCriterionIndexes"] : [])], "manualInput");
  if (revision && manualInput.intent !== "replace" && manualInput.intent !== "withdraw_all") {
    throw new Error("manual input revision intent가 올바르지 않습니다.");
  }
  if (!Array.isArray(manualInput.items) || (manualInput.items.length === 0 && manualInput.intent !== "withdraw_all")) {
    throw new Error("manual input envelope에는 질문이 하나 이상 필요합니다.");
  }
  const withdrawnCriterionIndexes = revision
    ? parseNonnegativeIndexes(manualInput.withdrawnCriterionIndexes, "manualInput.withdrawnCriterionIndexes")
    : null;
  const packetItems = new Map(draftPacket.items.map((item) => [item.criterionIndex, item]));
  const seen = new Set<number>();
  const items = manualInput.items.map((rawItem, index) => {
    const label = `manual input items[${index}]`;
    const value = record(rawItem, label);
    const companyFact = value.resolutionScope === "company_fact";
    exactKeys(value, companyFact
      ? ["criterionIndex", "resolutionScope", "conditionKey", "companyFactReview", "prompt", "options"]
      : ["criterionIndex", "resolutionScope", "prompt", "options"], label);
    if (!Number.isSafeInteger(value.criterionIndex) || (value.criterionIndex as number) < 0) {
      throw new Error(`${label}.criterionIndex가 올바르지 않습니다.`);
    }
    const criterionIndex = value.criterionIndex as number;
    if (seen.has(criterionIndex)) throw new Error(`manual input criterionIndex 중복: ${criterionIndex}`);
    seen.add(criterionIndex);
    const packetItem = packetItems.get(criterionIndex);
    if (!packetItem) throw new Error(`manual input criterionIndex ${criterionIndex}가 draft packet에 없습니다.`);
    if (value.resolutionScope !== "per_notice" && !companyFact) {
      throw new Error(`${label}.resolutionScope가 올바르지 않습니다.`);
    }
    const conditionKey = companyFact
      ? requiredConditionKey(value.conditionKey, `${label}.conditionKey`)
      : null;
    const companyFactReview = companyFact
      ? parseCompanyFactReview(value.companyFactReview, packetItem, draftPacket.source.reviewArtifactSha256, conditionKey!, label)
      : null;
    if (!Array.isArray(value.options) || value.options.length !== 3) {
      throw new Error(`${label}.options는 고정 3상태여야 합니다.`);
    }
    const options = value.options.map((option, optionIndex) =>
      parseOption(option, `${label}.options[${optionIndex}]`));
    for (let optionIndex = 0; optionIndex < 3; optionIndex += 1) {
      if (
        options[optionIndex]!.value !== packetItem.options[optionIndex]!.value
        || options[optionIndex]!.evaluation !== packetItem.options[optionIndex]!.evaluation
      ) {
        throw new Error(`${label}.options의 고정 값/평가 극성이 draft packet과 다릅니다.`);
      }
    }
    return {
      criterionIndex,
      resolutionScope: companyFact ? "company_fact" as const : "per_notice" as const,
      ...(conditionKey ? { conditionKey } : {}),
      ...(companyFactReview ? { companyFactReview } : {}),
      prompt: requiredText(value.prompt, `${label}.prompt`),
      options,
    };
  });
  if (items.some((item, index) => index > 0 && items[index - 1]!.criterionIndex >= item.criterionIndex)) {
    throw new Error("manual input items는 criterionIndex 오름차순이어야 합니다.");
  }
  return {
    schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
    draftPacket,
    manualInput: {
      questionAuthorEmail: requiredText(manualInput.questionAuthorEmail, "questionAuthorEmail"),
      ...(revision ? {
        intent: manualInput.intent as "replace" | "withdraw_all",
        withdrawnCriterionIndexes: withdrawnCriterionIndexes!,
      } : {}),
      items,
    },
  };
}

function parseNonnegativeIndexes(raw: unknown, label: string): number[] {
  if (!Array.isArray(raw) || raw.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label}가 올바르지 않습니다.`);
  }
  const sorted = [...raw as number[]].sort((left, right) => left - right);
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label}에 중복이 있습니다.`);
  return sorted;
}

/** Node와 브라우저가 같은 content hash 입력을 만들기 위한 순수 canonical JSON. */
export function canonicalConfirmationQuestionDraftJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON에는 유한한 숫자만 허용됩니다.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalConfirmationQuestionDraftJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalConfirmationQuestionDraftJson(source[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON에 지원하지 않는 값이 있습니다: ${typeof value}`);
}

function parseAuthority(raw: unknown): ConfirmationQuestionDraftPacketBody["authority"] {
  const value = record(raw, "authority");
  exactKeys(value, [
    "status",
    "modelCallsMade",
    "serviceDatabaseWritesMade",
    "releaseAuthorized",
    "promotionAuthorized",
    "liveQuestionWriteAuthorized",
    "currentServiceStateVerified",
  ], "authority");
  if (
    value.status !== "unreviewed_draft"
    || value.modelCallsMade !== 0
    || value.serviceDatabaseWritesMade !== 0
    || value.releaseAuthorized !== false
    || value.promotionAuthorized !== false
    || value.liveQuestionWriteAuthorized !== false
    || value.currentServiceStateVerified !== false
  ) {
    throw new Error("확인질문 draft authority는 무권한 offline 초안이어야 합니다.");
  }
  return {
    status: "unreviewed_draft",
    modelCallsMade: 0,
    serviceDatabaseWritesMade: 0,
    releaseAuthorized: false,
    promotionAuthorized: false,
    liveQuestionWriteAuthorized: false,
    currentServiceStateVerified: false,
  };
}

function parseSource(raw: unknown): ConfirmationQuestionDraftPacketBody["source"] {
  const value = record(raw, "source");
  exactKeys(value, [
    "grantId",
    "runId",
    "source",
    "sourceId",
    "inputSha256",
    "sourceRevisionSha256",
    "attachmentManifestSha256",
    "runArtifactSha256",
    "reviewArtifactSha256",
    "criterionReviewerEmail",
    "reviewUpdatedAt",
  ], "source");
  return {
    grantId: requiredText(value.grantId, "source.grantId"),
    runId: requiredText(value.runId, "source.runId"),
    source: requiredText(value.source, "source.source"),
    sourceId: requiredText(value.sourceId, "source.sourceId"),
    inputSha256: requiredSha256(value.inputSha256, "source.inputSha256"),
    sourceRevisionSha256: requiredSha256(
      value.sourceRevisionSha256,
      "source.sourceRevisionSha256",
    ),
    attachmentManifestSha256: value.attachmentManifestSha256 === null
      ? null
      : requiredSha256(value.attachmentManifestSha256, "source.attachmentManifestSha256"),
    runArtifactSha256: requiredSha256(value.runArtifactSha256, "source.runArtifactSha256"),
    reviewArtifactSha256: requiredSha256(
      value.reviewArtifactSha256,
      "source.reviewArtifactSha256",
    ),
    criterionReviewerEmail: requiredText(
      value.criterionReviewerEmail,
      "source.criterionReviewerEmail",
    ),
    reviewUpdatedAt: requiredCanonicalIso(value.reviewUpdatedAt, "source.reviewUpdatedAt"),
  };
}

function parseItem(raw: unknown, itemIndex: number): ConfirmationQuestionDraftItem {
  const label = `items[${itemIndex}]`;
  const value = record(raw, label);
  exactKeys(value, [
    "criterionIndex",
    "criterionKind",
    "polarity",
    "criterionSha256",
    "sourceSpan",
    "resolutionScope",
    "answerType",
    "prompt",
    "options",
    ...(Object.hasOwn(value, "normalizedCriterion") ? ["normalizedCriterion"] : []),
  ], label);
  if (!Number.isSafeInteger(value.criterionIndex) || (value.criterionIndex as number) < 0) {
    throw new Error(`${label}.criterionIndex가 올바르지 않습니다.`);
  }
  const criterionKind = value.criterionKind;
  if (criterionKind !== "required" && criterionKind !== "preferred" && criterionKind !== "exclusion") {
    throw new Error(`${label}.criterionKind가 올바르지 않습니다.`);
  }
  const expectedPolarity = criterionKind === "exclusion"
    ? "exclusion_membership"
    : "criterion_satisfaction";
  if (value.polarity !== expectedPolarity) {
    throw new Error(`${label}.polarity가 criterion kind와 일치하지 않습니다.`);
  }
  if (value.resolutionScope !== "per_notice" || value.answerType !== "single") {
    throw new Error(`${label}는 공고별 단일 선택 질문이어야 합니다.`);
  }
  if (!Array.isArray(value.options) || value.options.length !== 3) {
    throw new Error(`${label}.options는 고정 3상태여야 합니다.`);
  }
  const options = value.options.map((option, optionIndex) =>
    parseOption(option, `${label}.options[${optionIndex}]`));
  const expectedEvaluations = criterionKind === "exclusion"
    ? ["unsatisfied", "satisfied", "unknown"]
    : ["satisfied", "unsatisfied", "unknown"];
  const expectedValues = ["yes", "no", "unknown"];
  for (let index = 0; index < 3; index += 1) {
    if (
      options[index]!.value !== expectedValues[index]
      || options[index]!.evaluation !== expectedEvaluations[index]
    ) {
      throw new Error(`${label}.options의 값/평가 극성이 구조 계약과 일치하지 않습니다.`);
    }
  }
  return {
    criterionIndex: value.criterionIndex as number,
    criterionKind,
    polarity: expectedPolarity,
    criterionSha256: requiredSha256(value.criterionSha256, `${label}.criterionSha256`),
    sourceSpan: requiredText(value.sourceSpan, `${label}.sourceSpan`),
    ...(Object.hasOwn(value, "normalizedCriterion") ? {
      normalizedCriterion: parseNormalizedCriterion(value.normalizedCriterion, criterionKind, label),
    } : {}),
    resolutionScope: "per_notice",
    answerType: "single",
    prompt: requiredText(value.prompt, `${label}.prompt`),
    options: options as ConfirmationQuestionDraftItem["options"],
  };
}

function parseNormalizedCriterion(raw: unknown, kind: ConfirmationQuestionDraftCriterionKind, label: string): NonNullable<ConfirmationQuestionDraftItem["normalizedCriterion"]> {
  const value = record(raw, `${label}.normalizedCriterion`);
  exactKeys(value, ["dimension", "kind", "operator", "value"], `${label}.normalizedCriterion`);
  if (value.kind !== kind) throw new Error(`${label}.normalizedCriterion kind가 다릅니다.`);
  return {
    dimension: requiredText(value.dimension, `${label}.normalizedCriterion.dimension`),
    kind,
    operator: requiredText(value.operator, `${label}.normalizedCriterion.operator`),
    value: value.value,
  };
}

function parseCompanyFactReview(
  raw: unknown,
  packetItem: ConfirmationQuestionDraftItem,
  reviewArtifactSha256: string,
  definitionKey: string,
  label: string,
): CompanyFactReview {
  const value = record(raw, `${label}.companyFactReview`);
  if (value.definitionSource !== "new_review" && value.definitionSource !== "existing_reviewed") {
    throw new Error(`${label}.companyFactReview.definitionSource가 올바르지 않습니다.`);
  }
  const existing = value.definitionSource === "existing_reviewed";
  exactKeys(value, ["meaning", "definitionKey", "definitionSource", "scopeField", "scopeValue", "asOfField", "asOfDate", "reviewArtifactSha256", ...(existing ? ["existingDefinition"] : [])], `${label}.companyFactReview`);
  const boundary = normalizedCompanyFactBoundary(packetItem.normalizedCriterion?.value);
  if (!boundary) throw new Error(`${label}의 정규화 scope/기준일이 없어 회사 사실 공유를 보류합니다.`);
  if (value.reviewArtifactSha256 !== reviewArtifactSha256
    || value.definitionKey !== definitionKey
    || value.scopeField !== boundary.scopeField
    || canonicalConfirmationQuestionDraftJson(value.scopeValue) !== canonicalConfirmationQuestionDraftJson(boundary.scopeValue)
    || value.asOfField !== boundary.asOfField
    || value.asOfDate !== boundary.asOfDate) {
    throw new Error(`${label}의 회사 사실 검수 근거·scope·기준일이 draft packet과 다릅니다.`);
  }
  return {
    meaning: requiredText(value.meaning, `${label}.companyFactReview.meaning`),
    definitionKey: requiredConditionKey(value.definitionKey, `${label}.companyFactReview.definitionKey`),
    definitionSource: existing ? "existing_reviewed" : "new_review",
    ...(existing ? { existingDefinition: parseExistingDefinition(value.existingDefinition, label) } : {}),
    ...boundary,
    reviewArtifactSha256,
  };
}

function parseExistingDefinition(raw: unknown, label: string): NonNullable<CompanyFactReview["existingDefinition"]> {
  const value = record(raw, `${label}.companyFactReview.existingDefinition`);
  exactKeys(value, ["grantId", "runId", "revision", "artifactSha256", "criterionIndex"], `${label}.companyFactReview.existingDefinition`);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !Number.isSafeInteger(value.criterionIndex) || (value.criterionIndex as number) < 0) {
    throw new Error(`${label}.companyFactReview 기존 정의 selector가 올바르지 않습니다.`);
  }
  return {
    grantId: requiredText(value.grantId, `${label}.existingDefinition.grantId`),
    runId: requiredText(value.runId, `${label}.existingDefinition.runId`),
    revision: value.revision as number,
    artifactSha256: requiredSha256(value.artifactSha256, `${label}.existingDefinition.artifactSha256`),
    criterionIndex: value.criterionIndex as number,
  };
}

function parseOption(raw: unknown, label: string): ConfirmationQuestionDraftOption {
  const value = record(raw, label);
  exactKeys(value, ["value", "label", "evaluation"], label);
  if (value.value !== "yes" && value.value !== "no" && value.value !== "unknown") {
    throw new Error(`${label}.value가 올바르지 않습니다.`);
  }
  if (
    value.evaluation !== "satisfied"
    && value.evaluation !== "unsatisfied"
    && value.evaluation !== "unknown"
  ) {
    throw new Error(`${label}.evaluation이 올바르지 않습니다.`);
  }
  return {
    value: value.value,
    label: requiredText(value.label, `${label}.label`),
    evaluation: value.evaluation,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 필드가 계약과 정확히 일치하지 않습니다.`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label}가 올바르지 않습니다.`);
  }
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label}가 SHA-256 형식이 아닙니다.`);
  }
  return value;
}

function requiredConditionKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label}가 표준 사실 키 형식이 아닙니다.`);
  }
  return value;
}

function requiredCanonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}가 필요합니다.`);
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label}가 canonical ISO 시각이 아닙니다.`);
  }
  return value;
}

import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
  type CriterionDimension,
  type CriterionKind,
  type CriterionOperator,
} from "./index.js";

export const LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA =
  "legacy-question-migration-review-packet-v1" as const;
export const LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA =
  "legacy-question-migration-review-manifest-v1" as const;
export const LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA =
  "legacy-question-migration-review-decision-v1" as const;
export const LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA =
  "legacy-question-migration-review-decision-set-v1" as const;

export type LegacyQuestionMigrationReviewVerdict =
  | "approve_for_v2_draft"
  | "repair_criterion"
  | "retire_legacy_question";

export type LegacyQuestionMigrationResolutionScope = "per_notice" | "company_fact";
export type LegacyQuestionMigrationPolarity =
  | "criterion_satisfaction"
  | "exclusion_membership";

export interface LegacyQuestionMigrationReviewAuthority {
  readonly status: "human_review_required";
  readonly modelCallsMade: 0;
  readonly serviceDatabaseWritesMade: 0;
  readonly migrationAuthorized: false;
  readonly releaseAuthorized: false;
  readonly liveQuestionWriteAuthorized: false;
}

export interface LegacyQuestionMigrationReviewDetail {
  readonly grant: {
    readonly id: string;
    readonly title: string;
    readonly source: string;
    readonly sourceId: string;
    readonly url: string | null;
    readonly applyStart: string | null;
    readonly applyEnd: string | null;
  };
  readonly question: {
    readonly id: string;
    readonly grantId: string;
    readonly criterionId: string;
    readonly evaluationContractVersion: string | null;
    readonly sourceRevisionSha256: string | null;
    readonly sourceRawSha256: string | null;
    readonly criterionStableKey: string | null;
    readonly definitionSha256: string;
    readonly version: number;
    readonly prompt: string;
    readonly options: readonly Record<string, unknown>[];
    readonly answerType: string;
    readonly reusable: string;
    readonly conditionKey: string | null;
    readonly promptVersion: string;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  };
  readonly criterion: {
    readonly id: string;
    readonly stableKey: string | null;
    readonly dimension: CriterionDimension;
    readonly kind: CriterionKind;
    readonly operator: CriterionOperator;
    readonly value: Readonly<Record<string, unknown>>;
    readonly confidence: number;
    readonly sourceSpan: string;
    readonly sourceField: string | null;
    readonly needsReview: boolean;
    readonly parserVersion: string | null;
  };
}

export interface LegacyQuestionMigrationReviewPacketBody {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA;
  readonly authority: LegacyQuestionMigrationReviewAuthority;
  readonly shadow: {
    readonly schema: "legacy-question-migration-shadow-v1";
    readonly snapshotSha256: string;
    readonly observedAt: string;
  };
  readonly candidateSha256: string;
  readonly grant: LegacyQuestionMigrationReviewDetail["grant"];
  readonly currentSource: {
    readonly sourceRevisionSha256: string;
    readonly sourceRawSha256: string;
  };
  readonly legacyQuestion: LegacyQuestionMigrationReviewDetail["question"] & {
    readonly answerCount: number;
    readonly answeringCompanyCount: number;
  };
  readonly criterion: LegacyQuestionMigrationReviewDetail["criterion"];
  readonly requiredReview: {
    readonly allowedVerdicts: readonly LegacyQuestionMigrationReviewVerdict[];
    readonly expectedPolarity: LegacyQuestionMigrationPolarity;
    readonly allowedResolutionScopes: readonly LegacyQuestionMigrationResolutionScope[];
    readonly checks: readonly string[];
    readonly decisionTemplate: {
      readonly schema: typeof LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA;
      readonly packetContentSha256: null;
      readonly candidateSha256: string;
      readonly grantId: string;
      readonly questionId: string;
      readonly criterionId: string;
      readonly verdict: null;
      readonly confirmedPolarity: null;
      readonly resolutionScope: null;
      readonly reviewerEmail: null;
      readonly reviewedAt: null;
      readonly note: null;
    };
  };
}

export interface LegacyQuestionMigrationReviewPacket
  extends LegacyQuestionMigrationReviewPacketBody {
  readonly contentSha256: string;
}

export interface LegacyQuestionMigrationReviewManifestBody {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA;
  readonly authority: LegacyQuestionMigrationReviewAuthority;
  readonly shadow: LegacyQuestionMigrationReviewPacketBody["shadow"];
  readonly packetCount: number;
  readonly answerPreservationReviewCount: number;
  readonly packets: readonly {
    readonly grantId: string;
    readonly questionId: string;
    readonly criterionId: string;
    readonly candidateSha256: string;
    readonly packetContentSha256: string;
    readonly fileName: string;
  }[];
}

export interface LegacyQuestionMigrationReviewManifest
  extends LegacyQuestionMigrationReviewManifestBody {
  readonly contentSha256: string;
}

export interface LegacyQuestionMigrationReviewDecision {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA;
  readonly packetContentSha256: string;
  readonly candidateSha256: string;
  readonly grantId: string;
  readonly questionId: string;
  readonly criterionId: string;
  readonly verdict: LegacyQuestionMigrationReviewVerdict;
  readonly confirmedPolarity: LegacyQuestionMigrationPolarity | null;
  readonly resolutionScope: LegacyQuestionMigrationResolutionScope | null;
  readonly reviewerEmail: string;
  readonly reviewedAt: string;
  readonly note: string | null;
}

export interface LegacyQuestionMigrationReviewDecisionSetBody {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA;
  readonly authority: {
    readonly status: "human_review_record_only";
    readonly serviceDatabaseWritesMade: 0;
    readonly migrationAuthorized: false;
    readonly releaseAuthorized: false;
    readonly liveQuestionWriteAuthorized: false;
  };
  readonly manifestContentSha256: string;
  readonly shadowSnapshotSha256: string;
  readonly createdAt: string;
  readonly decisions: readonly LegacyQuestionMigrationReviewDecision[];
}

export interface LegacyQuestionMigrationReviewDecisionSet
  extends LegacyQuestionMigrationReviewDecisionSetBody {
  readonly contentSha256: string;
}

export function parseLegacyQuestionMigrationReviewPacket(
  raw: unknown,
): LegacyQuestionMigrationReviewPacket {
  const packet = record(raw, "migration review packet");
  exactKeys(packet, [
    "schema", "authority", "shadow", "candidateSha256", "grant", "currentSource",
    "legacyQuestion", "criterion", "requiredReview", "contentSha256",
  ], "migration review packet");
  if (packet.schema !== LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA) {
    throw new Error("migration review packet schema가 올바르지 않습니다.");
  }
  return {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
    authority: parseReviewAuthority(packet.authority),
    shadow: parseShadow(packet.shadow),
    candidateSha256: sha256(packet.candidateSha256, "candidateSha256"),
    grant: parseGrant(packet.grant),
    currentSource: parseCurrentSource(packet.currentSource),
    legacyQuestion: parseLegacyQuestion(packet.legacyQuestion),
    criterion: parseCriterion(packet.criterion),
    requiredReview: parseRequiredReview(packet.requiredReview),
    contentSha256: sha256(packet.contentSha256, "contentSha256"),
  };
}

export function parseLegacyQuestionMigrationReviewManifest(
  raw: unknown,
): LegacyQuestionMigrationReviewManifest {
  const manifest = record(raw, "migration review manifest");
  exactKeys(manifest, [
    "schema", "authority", "shadow", "packetCount", "answerPreservationReviewCount",
    "packets", "contentSha256",
  ], "migration review manifest");
  if (manifest.schema !== LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA) {
    throw new Error("migration review manifest schema가 올바르지 않습니다.");
  }
  const packetCount = nonNegativeInteger(manifest.packetCount, "packetCount");
  if (!Array.isArray(manifest.packets) || manifest.packets.length !== packetCount) {
    throw new Error("migration review manifest packetCount가 packets와 다릅니다.");
  }
  const seenQuestions = new Set<string>();
  const packets = manifest.packets.map((rawEntry, index) => {
    const label = `manifest.packets[${index}]`;
    const entry = record(rawEntry, label);
    exactKeys(entry, [
      "grantId", "questionId", "criterionId", "candidateSha256", "packetContentSha256", "fileName",
    ], label);
    const questionId = text(entry.questionId, `${label}.questionId`);
    if (seenQuestions.has(questionId)) throw new Error(`manifest questionId 중복: ${questionId}`);
    seenQuestions.add(questionId);
    return {
      grantId: text(entry.grantId, `${label}.grantId`),
      questionId,
      criterionId: text(entry.criterionId, `${label}.criterionId`),
      candidateSha256: sha256(entry.candidateSha256, `${label}.candidateSha256`),
      packetContentSha256: sha256(entry.packetContentSha256, `${label}.packetContentSha256`),
      fileName: text(entry.fileName, `${label}.fileName`),
    };
  });
  const answerPreservationReviewCount = nonNegativeInteger(
    manifest.answerPreservationReviewCount,
    "answerPreservationReviewCount",
  );
  if (answerPreservationReviewCount > packetCount) {
    throw new Error("answerPreservationReviewCount가 packetCount보다 클 수 없습니다.");
  }
  return {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
    authority: parseReviewAuthority(manifest.authority),
    shadow: parseShadow(manifest.shadow),
    packetCount,
    answerPreservationReviewCount,
    packets,
    contentSha256: sha256(manifest.contentSha256, "contentSha256"),
  };
}

export function parseLegacyQuestionMigrationReviewDecision(
  raw: unknown,
): LegacyQuestionMigrationReviewDecision {
  const value = record(raw, "migration review decision");
  exactKeys(value, [
    "schema", "packetContentSha256", "candidateSha256", "grantId", "questionId",
    "criterionId", "verdict", "confirmedPolarity", "resolutionScope", "reviewerEmail",
    "reviewedAt", "note",
  ], "migration review decision");
  if (value.schema !== LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA) {
    throw new Error("migration review decision schema가 올바르지 않습니다.");
  }
  if (!isVerdict(value.verdict)) throw new Error("migration review verdict가 올바르지 않습니다.");
  const confirmedPolarity = value.confirmedPolarity === null
    ? null
    : isPolarity(value.confirmedPolarity)
      ? value.confirmedPolarity
      : fail("migration review confirmedPolarity가 올바르지 않습니다.");
  const resolutionScope = value.resolutionScope === null
    ? null
    : isScope(value.resolutionScope)
      ? value.resolutionScope
      : fail("migration review resolutionScope가 올바르지 않습니다.");
  if (value.verdict === "approve_for_v2_draft") {
    if (!confirmedPolarity || !resolutionScope) {
      throw new Error("v2 draft 승인에는 평가 극성과 질문 해소 범위가 필요합니다.");
    }
  } else if (confirmedPolarity !== null || resolutionScope !== null) {
    throw new Error("수리·철회 결정에는 평가 극성과 질문 해소 범위를 기록하지 않습니다.");
  }
  return {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
    packetContentSha256: sha256(value.packetContentSha256, "packetContentSha256"),
    candidateSha256: sha256(value.candidateSha256, "candidateSha256"),
    grantId: text(value.grantId, "grantId"),
    questionId: text(value.questionId, "questionId"),
    criterionId: text(value.criterionId, "criterionId"),
    verdict: value.verdict,
    confirmedPolarity,
    resolutionScope,
    reviewerEmail: text(value.reviewerEmail, "reviewerEmail"),
    reviewedAt: iso(value.reviewedAt, "reviewedAt"),
    note: nullableText(value.note, "note"),
  };
}

export function parseLegacyQuestionMigrationReviewDecisionSet(
  raw: unknown,
): LegacyQuestionMigrationReviewDecisionSet {
  const set = record(raw, "migration review decision set");
  exactKeys(set, [
    "schema", "authority", "manifestContentSha256", "shadowSnapshotSha256",
    "createdAt", "decisions", "contentSha256",
  ], "migration review decision set");
  if (set.schema !== LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA) {
    throw new Error("migration review decision set schema가 올바르지 않습니다.");
  }
  const authority = record(set.authority, "decision set authority");
  exactKeys(authority, [
    "status", "serviceDatabaseWritesMade", "migrationAuthorized", "releaseAuthorized",
    "liveQuestionWriteAuthorized",
  ], "decision set authority");
  if (
    authority.status !== "human_review_record_only"
    || authority.serviceDatabaseWritesMade !== 0
    || authority.migrationAuthorized !== false
    || authority.releaseAuthorized !== false
    || authority.liveQuestionWriteAuthorized !== false
  ) {
    throw new Error("decision set authority는 쓰기 권한 없는 사람 검수 기록이어야 합니다.");
  }
  if (!Array.isArray(set.decisions) || set.decisions.length === 0) {
    throw new Error("decision set에는 결정이 하나 이상 필요합니다.");
  }
  const seen = new Set<string>();
  const decisions = set.decisions.map(parseLegacyQuestionMigrationReviewDecision);
  const reviewerEmail = decisions[0]?.reviewerEmail;
  for (const decision of decisions) {
    if (seen.has(decision.questionId)) throw new Error(`decision questionId 중복: ${decision.questionId}`);
    if (decision.reviewedAt !== set.createdAt) {
      throw new Error("decision reviewedAt은 decision set createdAt과 같아야 합니다.");
    }
    if (decision.reviewerEmail !== reviewerEmail) {
      throw new Error("decision set은 한 사람 검수자의 결정만 포함해야 합니다.");
    }
    seen.add(decision.questionId);
  }
  return {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA,
    authority: {
      status: "human_review_record_only",
      serviceDatabaseWritesMade: 0,
      migrationAuthorized: false,
      releaseAuthorized: false,
      liveQuestionWriteAuthorized: false,
    },
    manifestContentSha256: sha256(set.manifestContentSha256, "manifestContentSha256"),
    shadowSnapshotSha256: sha256(set.shadowSnapshotSha256, "shadowSnapshotSha256"),
    createdAt: iso(set.createdAt, "createdAt"),
    decisions,
    contentSha256: sha256(set.contentSha256, "contentSha256"),
  };
}

export function legacyQuestionMigrationReviewPacketBody(
  packet: LegacyQuestionMigrationReviewPacket,
): LegacyQuestionMigrationReviewPacketBody {
  const { contentSha256: _contentSha256, ...body } = packet;
  return body;
}

export function legacyQuestionMigrationReviewManifestBody(
  manifest: LegacyQuestionMigrationReviewManifest,
): LegacyQuestionMigrationReviewManifestBody {
  const { contentSha256: _contentSha256, ...body } = manifest;
  return body;
}

export function legacyQuestionMigrationReviewDecisionSetBody(
  set: LegacyQuestionMigrationReviewDecisionSet,
): LegacyQuestionMigrationReviewDecisionSetBody {
  const { contentSha256: _contentSha256, ...body } = set;
  return body;
}

export function canonicalLegacyQuestionMigrationReviewJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON에는 유한한 숫자만 허용됩니다.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalLegacyQuestionMigrationReviewJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalLegacyQuestionMigrationReviewJson(source[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON에 지원하지 않는 값이 있습니다: ${typeof value}`);
}

function parseReviewAuthority(raw: unknown): LegacyQuestionMigrationReviewAuthority {
  const value = record(raw, "review authority");
  exactKeys(value, [
    "status", "modelCallsMade", "serviceDatabaseWritesMade", "migrationAuthorized",
    "releaseAuthorized", "liveQuestionWriteAuthorized",
  ], "review authority");
  if (
    value.status !== "human_review_required"
    || value.modelCallsMade !== 0
    || value.serviceDatabaseWritesMade !== 0
    || value.migrationAuthorized !== false
    || value.releaseAuthorized !== false
    || value.liveQuestionWriteAuthorized !== false
  ) throw new Error("review authority는 쓰기 권한 없는 사람 검수 상태여야 합니다.");
  return {
    status: "human_review_required",
    modelCallsMade: 0,
    serviceDatabaseWritesMade: 0,
    migrationAuthorized: false,
    releaseAuthorized: false,
    liveQuestionWriteAuthorized: false,
  };
}

function parseShadow(raw: unknown): LegacyQuestionMigrationReviewPacketBody["shadow"] {
  const value = record(raw, "shadow binding");
  exactKeys(value, ["schema", "snapshotSha256", "observedAt"], "shadow binding");
  if (value.schema !== "legacy-question-migration-shadow-v1") {
    throw new Error("shadow schema가 올바르지 않습니다.");
  }
  return {
    schema: "legacy-question-migration-shadow-v1",
    snapshotSha256: sha256(value.snapshotSha256, "snapshotSha256"),
    observedAt: iso(value.observedAt, "observedAt"),
  };
}

function parseGrant(raw: unknown): LegacyQuestionMigrationReviewDetail["grant"] {
  const value = record(raw, "grant");
  exactKeys(value, ["id", "title", "source", "sourceId", "url", "applyStart", "applyEnd"], "grant");
  return {
    id: text(value.id, "grant.id"),
    title: text(value.title, "grant.title"),
    source: text(value.source, "grant.source"),
    sourceId: text(value.sourceId, "grant.sourceId"),
    url: nullableHttpUrl(value.url, "grant.url"),
    applyStart: nullableIso(value.applyStart, "grant.applyStart"),
    applyEnd: nullableIso(value.applyEnd, "grant.applyEnd"),
  };
}

function parseCurrentSource(raw: unknown) {
  const value = record(raw, "currentSource");
  exactKeys(value, ["sourceRevisionSha256", "sourceRawSha256"], "currentSource");
  return {
    sourceRevisionSha256: sha256(value.sourceRevisionSha256, "currentSource.sourceRevisionSha256"),
    sourceRawSha256: sha256(value.sourceRawSha256, "currentSource.sourceRawSha256"),
  };
}

function parseLegacyQuestion(raw: unknown): LegacyQuestionMigrationReviewPacketBody["legacyQuestion"] {
  const value = record(raw, "legacyQuestion");
  exactKeys(value, [
    "id", "grantId", "criterionId", "evaluationContractVersion", "sourceRevisionSha256",
    "sourceRawSha256", "criterionStableKey", "definitionSha256", "version", "prompt", "options",
    "answerType", "reusable", "conditionKey", "promptVersion", "provenance", "createdAt",
    "answerCount", "answeringCompanyCount",
  ], "legacyQuestion");
  if (!Array.isArray(value.options) || value.options.length === 0) {
    throw new Error("legacyQuestion.options가 필요합니다.");
  }
  const options = value.options.map((option, index) => ({
    ...record(option, `legacyQuestion.options[${index}]`),
  }));
  return {
    id: text(value.id, "legacyQuestion.id"),
    grantId: text(value.grantId, "legacyQuestion.grantId"),
    criterionId: text(value.criterionId, "legacyQuestion.criterionId"),
    evaluationContractVersion: nullableText(value.evaluationContractVersion, "legacyQuestion.evaluationContractVersion"),
    sourceRevisionSha256: nullableSha256(value.sourceRevisionSha256, "legacyQuestion.sourceRevisionSha256"),
    sourceRawSha256: nullableSha256(value.sourceRawSha256, "legacyQuestion.sourceRawSha256"),
    criterionStableKey: nullableText(value.criterionStableKey, "legacyQuestion.criterionStableKey"),
    definitionSha256: text(value.definitionSha256, "legacyQuestion.definitionSha256"),
    version: positiveInteger(value.version, "legacyQuestion.version"),
    prompt: text(value.prompt, "legacyQuestion.prompt"),
    options,
    answerType: text(value.answerType, "legacyQuestion.answerType"),
    reusable: text(value.reusable, "legacyQuestion.reusable"),
    conditionKey: nullableText(value.conditionKey, "legacyQuestion.conditionKey"),
    promptVersion: text(value.promptVersion, "legacyQuestion.promptVersion"),
    provenance: { ...record(value.provenance, "legacyQuestion.provenance") },
    createdAt: iso(value.createdAt, "legacyQuestion.createdAt"),
    answerCount: nonNegativeInteger(value.answerCount, "legacyQuestion.answerCount"),
    answeringCompanyCount: nonNegativeInteger(value.answeringCompanyCount, "legacyQuestion.answeringCompanyCount"),
  };
}

function parseCriterion(raw: unknown): LegacyQuestionMigrationReviewDetail["criterion"] {
  const value = record(raw, "criterion");
  exactKeys(value, [
    "id", "stableKey", "dimension", "kind", "operator", "value", "confidence", "sourceSpan",
    "sourceField", "needsReview", "parserVersion",
  ], "criterion");
  if (!isCriterionDimension(value.dimension) || !isCriterionKind(value.kind) || !isCriterionOperator(value.operator)) {
    throw new Error("criterion dimension/kind/operator가 필요합니다.");
  }
  if (
    typeof value.confidence !== "number"
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
  ) {
    throw new Error("criterion confidence가 올바르지 않습니다.");
  }
  if (typeof value.needsReview !== "boolean") throw new Error("criterion needsReview가 필요합니다.");
  return {
    id: text(value.id, "criterion.id"),
    stableKey: nullableText(value.stableKey, "criterion.stableKey"),
    dimension: value.dimension,
    kind: value.kind,
    operator: value.operator,
    value: { ...record(value.value, "criterion.value") },
    confidence: value.confidence,
    sourceSpan: text(value.sourceSpan, "criterion.sourceSpan"),
    sourceField: nullableText(value.sourceField, "criterion.sourceField"),
    needsReview: value.needsReview,
    parserVersion: nullableText(value.parserVersion, "criterion.parserVersion"),
  };
}

function parseRequiredReview(raw: unknown): LegacyQuestionMigrationReviewPacketBody["requiredReview"] {
  const value = record(raw, "requiredReview");
  exactKeys(value, [
    "allowedVerdicts", "expectedPolarity", "allowedResolutionScopes", "checks", "decisionTemplate",
  ], "requiredReview");
  if (
    !Array.isArray(value.allowedVerdicts)
    || value.allowedVerdicts.length !== 3
    || value.allowedVerdicts.some((item) => !isVerdict(item))
    || new Set(value.allowedVerdicts).size !== 3
  ) throw new Error("requiredReview.allowedVerdicts가 올바르지 않습니다.");
  if (!isPolarity(value.expectedPolarity)) throw new Error("requiredReview.expectedPolarity가 올바르지 않습니다.");
  if (
    !Array.isArray(value.allowedResolutionScopes)
    || value.allowedResolutionScopes.length !== 2
    || value.allowedResolutionScopes.some((item) => !isScope(item))
    || new Set(value.allowedResolutionScopes).size !== 2
  ) throw new Error("requiredReview.allowedResolutionScopes가 올바르지 않습니다.");
  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("requiredReview.checks가 올바르지 않습니다.");
  }
  const template = record(value.decisionTemplate, "decisionTemplate");
  exactKeys(template, [
    "schema", "packetContentSha256", "candidateSha256", "grantId", "questionId", "criterionId",
    "verdict", "confirmedPolarity", "resolutionScope", "reviewerEmail", "reviewedAt", "note",
  ], "decisionTemplate");
  if (
    template.schema !== LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA
    || template.packetContentSha256 !== null
    || template.verdict !== null
    || template.confirmedPolarity !== null
    || template.resolutionScope !== null
    || template.reviewerEmail !== null
    || template.reviewedAt !== null
    || template.note !== null
  ) throw new Error("decisionTemplate은 미작성 상태여야 합니다.");
  return {
    allowedVerdicts: value.allowedVerdicts as LegacyQuestionMigrationReviewVerdict[],
    expectedPolarity: value.expectedPolarity,
    allowedResolutionScopes: value.allowedResolutionScopes as LegacyQuestionMigrationResolutionScope[],
    checks: value.checks as string[],
    decisionTemplate: {
      schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
      packetContentSha256: null,
      candidateSha256: sha256(template.candidateSha256, "decisionTemplate.candidateSha256"),
      grantId: text(template.grantId, "decisionTemplate.grantId"),
      questionId: text(template.questionId, "decisionTemplate.questionId"),
      criterionId: text(template.criterionId, "decisionTemplate.criterionId"),
      verdict: null,
      confirmedPolarity: null,
      resolutionScope: null,
      reviewerEmail: null,
      reviewedAt: null,
      note: null,
    },
  };
}

function isVerdict(value: unknown): value is LegacyQuestionMigrationReviewVerdict {
  return value === "approve_for_v2_draft" || value === "repair_criterion" || value === "retire_legacy_question";
}

function isPolarity(value: unknown): value is LegacyQuestionMigrationPolarity {
  return value === "criterion_satisfaction" || value === "exclusion_membership";
}

function isScope(value: unknown): value is LegacyQuestionMigrationResolutionScope {
  return value === "per_notice" || value === "company_fact";
}

function isCriterionDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string" && CRITERION_DIMENSIONS.includes(value as CriterionDimension);
}

function isCriterionKind(value: unknown): value is CriterionKind {
  return typeof value === "string" && CRITERION_KINDS.includes(value as CriterionKind);
}

function isCriterionOperator(value: unknown): value is CriterionOperator {
  return typeof value === "string" && CRITERION_OPERATORS.includes(value as CriterionOperator);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}는 객체여야 합니다.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} 필드가 계약과 정확히 일치하지 않습니다.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 필요합니다.`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function nullableHttpUrl(value: unknown, label: string): string | null {
  if (value === null) return null;
  const parsed = text(value, label);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${label}가 URL이 아닙니다.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label}는 http 또는 https URL이어야 합니다.`);
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return value;
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label);
}

function iso(value: unknown, label: string): string {
  try {
    if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label}가 canonical ISO 시각이 아닙니다.`);
  }
  return value as string;
}

function nullableIso(value: unknown, label: string): string | null {
  return value === null ? null : iso(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}가 0 이상의 정수가 아닙니다.`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label}가 양의 정수가 아닙니다.`);
  return parsed;
}

function fail(message: string): never {
  throw new Error(message);
}

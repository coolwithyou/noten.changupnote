import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CriterionDimension, CriterionKind, CriterionOperator } from "@cunote/contracts";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { validateReviewerEmail } from "../analysis-lab/review-store";
import {
  loadLegacyQuestionMigrationShadow,
  type LegacyQuestionMigrationShadowEntry,
  type LegacyQuestionMigrationShadowReport,
} from "./legacyQuestionMigrationShadow";

export const LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA =
  "legacy-question-migration-review-packet-v1" as const;
export const LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA =
  "legacy-question-migration-review-manifest-v1" as const;
export const LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA =
  "legacy-question-migration-review-decision-v1" as const;

export type LegacyQuestionMigrationReviewVerdict =
  | "approve_for_v2_draft"
  | "repair_criterion"
  | "retire_legacy_question";

export type LegacyQuestionMigrationResolutionScope = "per_notice" | "company_fact";
export type LegacyQuestionMigrationPolarity =
  | "criterion_satisfaction"
  | "exclusion_membership";

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
  readonly authority: {
    readonly status: "human_review_required";
    readonly modelCallsMade: 0;
    readonly serviceDatabaseWritesMade: 0;
    readonly migrationAuthorized: false;
    readonly releaseAuthorized: false;
    readonly liveQuestionWriteAuthorized: false;
  };
  readonly shadow: {
    readonly schema: LegacyQuestionMigrationShadowReport["schema"];
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
  readonly authority: LegacyQuestionMigrationReviewPacketBody["authority"];
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

export interface LegacyQuestionMigrationReviewBundle {
  readonly shadowReport: LegacyQuestionMigrationShadowReport;
  readonly packets: readonly LegacyQuestionMigrationReviewPacket[];
  readonly manifest: LegacyQuestionMigrationReviewManifest;
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

export function buildLegacyQuestionMigrationReviewBundle(input: {
  readonly shadowReport: LegacyQuestionMigrationShadowReport;
  readonly details: readonly LegacyQuestionMigrationReviewDetail[];
}): LegacyQuestionMigrationReviewBundle {
  assertShadowReportHash(input.shadowReport);
  const candidateEntries = input.shadowReport.entries.filter(isReviewCandidate);
  const entryByQuestionId = uniqueMap(candidateEntries, (entry) => entry.questionId, "shadow question");
  const detailByQuestionId = uniqueMap(input.details, (detail) => detail.question.id, "detail question");
  if (entryByQuestionId.size !== detailByQuestionId.size) {
    throw new Error("shadow 검수 후보와 detail 수량이 일치하지 않습니다.");
  }
  const packets = [...entryByQuestionId.values()]
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .map((entry) => {
      const detail = detailByQuestionId.get(entry.questionId);
      if (!detail) throw new Error(`검수 후보 detail 누락: ${entry.questionId}`);
      return buildLegacyQuestionMigrationReviewPacket({
        shadowReport: input.shadowReport,
        entry,
        detail,
      });
    });
  const authority = reviewAuthority();
  const shadow = shadowBinding(input.shadowReport);
  const manifestBody: LegacyQuestionMigrationReviewManifestBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
    authority,
    shadow,
    packetCount: packets.length,
    answerPreservationReviewCount: candidateEntries.filter((entry) =>
      entry.disposition === "legacy_answer_preservation_review").length,
    packets: packets.map((packet) => ({
      grantId: packet.grant.id,
      questionId: packet.legacyQuestion.id,
      criterionId: packet.criterion.id,
      candidateSha256: packet.candidateSha256,
      packetContentSha256: packet.contentSha256,
      fileName: `${packet.legacyQuestion.id}.${packet.contentSha256}.json`,
    })),
  };
  const manifest = Object.freeze({
    ...manifestBody,
    contentSha256: sha256(stableJson(manifestBody)),
  });
  return Object.freeze({
    shadowReport: input.shadowReport,
    packets: Object.freeze(packets),
    manifest,
  });
}

function buildLegacyQuestionMigrationReviewPacket(input: {
  readonly shadowReport: LegacyQuestionMigrationShadowReport;
  readonly entry: LegacyQuestionMigrationShadowEntry;
  readonly detail: LegacyQuestionMigrationReviewDetail;
}): LegacyQuestionMigrationReviewPacket {
  const { entry, detail } = input;
  if (!isReviewCandidate(entry) || entry.automaticMigrationAllowed !== false) {
    throw new Error("사람 검수 대상으로 분류된 legacy 질문만 packet으로 만들 수 있습니다.");
  }
  assertDetailBinding(entry, detail);
  const candidateEvidence = {
    grant: detail.grant,
    currentSource: {
      sourceRevisionSha256: entry.currentSourceRevisionSha256,
      sourceRawSha256: entry.currentSourceRawSha256,
    },
    legacyQuestion: {
      ...detail.question,
      answerCount: entry.answerCount,
      answeringCompanyCount: entry.answeringCompanyCount,
    },
    criterion: detail.criterion,
  };
  const candidateSha256 = sha256(stableJson(candidateEvidence));
  const body: LegacyQuestionMigrationReviewPacketBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
    authority: reviewAuthority(),
    shadow: shadowBinding(input.shadowReport),
    candidateSha256,
    grant: detail.grant,
    currentSource: {
      sourceRevisionSha256: entry.currentSourceRevisionSha256!,
      sourceRawSha256: entry.currentSourceRawSha256!,
    },
    legacyQuestion: candidateEvidence.legacyQuestion,
    criterion: detail.criterion,
    requiredReview: {
      allowedVerdicts: ["approve_for_v2_draft", "repair_criterion", "retire_legacy_question"],
      expectedPolarity: detail.criterion.kind === "exclusion"
        ? "exclusion_membership"
        : "criterion_satisfaction",
      allowedResolutionScopes: ["per_notice", "company_fact"],
      checks: [
        "source_span이 현재 공고의 실제 자격 조건인지 확인",
        "legacy 질문과 선택지가 같은 조건을 묻는지 확인",
        "criterion kind에 따른 평가 극성을 확인",
        "답변을 다른 공고와 공유할 수 있는 회사 사실인지 범위를 확인",
      ],
      decisionTemplate: {
        schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
        packetContentSha256: null,
        candidateSha256,
        grantId: detail.grant.id,
        questionId: detail.question.id,
        criterionId: detail.criterion.id,
        verdict: null,
        confirmedPolarity: null,
        resolutionScope: null,
        reviewerEmail: null,
        reviewedAt: null,
        note: null,
      },
    },
  };
  return Object.freeze({
    ...body,
    contentSha256: sha256(stableJson(body)),
  });
}

export function validateLegacyQuestionMigrationReviewDecision(input: {
  readonly packet: LegacyQuestionMigrationReviewPacket;
  readonly decision: unknown;
}): LegacyQuestionMigrationReviewDecision {
  assertPacketHash(input.packet);
  if (!input.decision || typeof input.decision !== "object" || Array.isArray(input.decision)) {
    throw new Error("이관 검수 결정은 객체여야 합니다.");
  }
  const value = input.decision as Record<string, unknown>;
  const exactKeys = [
    "schema", "packetContentSha256", "candidateSha256", "grantId", "questionId",
    "criterionId", "verdict", "confirmedPolarity", "resolutionScope", "reviewerEmail",
    "reviewedAt", "note",
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys)) {
    throw new Error("이관 검수 결정 필드가 정확한 계약과 다릅니다.");
  }
  if (
    value.schema !== LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA
    || value.packetContentSha256 !== input.packet.contentSha256
    || value.candidateSha256 !== input.packet.candidateSha256
    || value.grantId !== input.packet.grant.id
    || value.questionId !== input.packet.legacyQuestion.id
    || value.criterionId !== input.packet.criterion.id
  ) {
    throw new Error("이관 검수 결정이 packet의 exact binding과 다릅니다.");
  }
  const allowedVerdicts = new Set<unknown>(input.packet.requiredReview.allowedVerdicts);
  if (!allowedVerdicts.has(value.verdict)) throw new Error("이관 검수 verdict가 올바르지 않습니다.");
  const verdict = value.verdict as LegacyQuestionMigrationReviewVerdict;
  if (typeof value.reviewerEmail !== "string") {
    throw new Error("검수자 이메일이 필요합니다.");
  }
  const reviewer = validateReviewerEmail(value.reviewerEmail);
  if (!reviewer.ok) throw new Error(reviewer.reason);
  const reviewedAt = canonicalIso(value.reviewedAt, "reviewedAt");
  const note = value.note === null
    ? null
    : typeof value.note === "string" && value.note.trim()
      ? value.note.trim()
      : fail("note는 null 또는 비어 있지 않은 문자열이어야 합니다.");
  let confirmedPolarity: LegacyQuestionMigrationPolarity | null = null;
  let resolutionScope: LegacyQuestionMigrationResolutionScope | null = null;
  if (verdict === "approve_for_v2_draft") {
    if (value.confirmedPolarity !== input.packet.requiredReview.expectedPolarity) {
      throw new Error("승인된 평가 극성이 criterion kind와 일치하지 않습니다.");
    }
    if (!input.packet.requiredReview.allowedResolutionScopes.includes(
      value.resolutionScope as LegacyQuestionMigrationResolutionScope,
    )) {
      throw new Error("승인된 질문 해소 범위가 올바르지 않습니다.");
    }
    confirmedPolarity = value.confirmedPolarity as LegacyQuestionMigrationPolarity;
    resolutionScope = value.resolutionScope as LegacyQuestionMigrationResolutionScope;
  } else if (value.confirmedPolarity !== null || value.resolutionScope !== null) {
    throw new Error("수리·철회 결정에는 평가 극성과 질문 해소 범위를 기록하지 않습니다.");
  }
  return Object.freeze({
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
    packetContentSha256: input.packet.contentSha256,
    candidateSha256: input.packet.candidateSha256,
    grantId: input.packet.grant.id,
    questionId: input.packet.legacyQuestion.id,
    criterionId: input.packet.criterion.id,
    verdict,
    confirmedPolarity,
    resolutionScope,
    reviewerEmail: reviewer.email,
    reviewedAt,
    note,
  });
}

/** 같은 repeatable-read transaction에서 shadow와 검수 detail을 exact 재결속한다. */
export async function loadLegacyQuestionMigrationReviewBundle(input: {
  readonly db: CunoteDbSession;
  readonly asOf?: Date;
  readonly limit?: number;
}): Promise<LegacyQuestionMigrationReviewBundle> {
  const shadowReport = await loadLegacyQuestionMigrationShadow(input);
  const candidateIds = shadowReport.entries.filter(isReviewCandidate).map((entry) => entry.questionId);
  if (candidateIds.length === 0) {
    return buildLegacyQuestionMigrationReviewBundle({ shadowReport, details: [] });
  }
  const rows = await input.db.select({
    grantId: schema.grants.id,
    grantTitle: schema.grants.title,
    grantSource: schema.grants.source,
    grantSourceId: schema.grants.sourceId,
    grantUrl: schema.grants.url,
    grantApplyStart: schema.grants.applyStart,
    grantApplyEnd: schema.grants.applyEnd,
    questionId: schema.grantConfirmationQuestions.id,
    questionGrantId: schema.grantConfirmationQuestions.grantId,
    questionEvaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
    questionSourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
    questionSourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
    questionCriterionStableKey: schema.grantConfirmationQuestions.criterionStableKey,
    questionDefinitionSha256: schema.grantConfirmationQuestions.definitionSha256,
    questionVersion: schema.grantConfirmationQuestions.version,
    questionPrompt: schema.grantConfirmationQuestions.prompt,
    questionOptions: schema.grantConfirmationQuestions.options,
    questionAnswerType: schema.grantConfirmationQuestions.answerType,
    questionReusable: schema.grantConfirmationQuestions.reusable,
    questionConditionKey: schema.grantConfirmationQuestions.conditionKey,
    questionPromptVersion: schema.grantConfirmationQuestions.promptVer,
    questionProvenance: schema.grantConfirmationQuestions.provenance,
    questionCreatedAt: schema.grantConfirmationQuestions.createdAt,
    criterionId: schema.grantCriteria.id,
    criterionStableKey: schema.grantCriteria.stableKey,
    criterionDimension: schema.grantCriteria.dimension,
    criterionKind: schema.grantCriteria.kind,
    criterionOperator: schema.grantCriteria.operator,
    criterionValue: schema.grantCriteria.value,
    criterionConfidence: schema.grantCriteria.confidence,
    criterionSourceSpan: schema.grantCriteria.sourceSpan,
    criterionSourceField: schema.grantCriteria.sourceField,
    criterionNeedsReview: schema.grantCriteria.needsReview,
    criterionParserVersion: schema.grantCriteria.parserVersion,
  }).from(schema.grantConfirmationQuestions)
    .innerJoin(schema.grants, eq(schema.grants.id, schema.grantConfirmationQuestions.grantId))
    .innerJoin(
      schema.grantCriteria,
      eq(schema.grantCriteria.id, schema.grantConfirmationQuestions.grantCriteriaId),
    )
    .where(and(
      inArray(schema.grantConfirmationQuestions.id, candidateIds),
      isNull(schema.grantConfirmationQuestions.invalidatedAt),
    ));
  const details = rows.map((row): LegacyQuestionMigrationReviewDetail => {
    if (!row.criterionSourceSpan?.trim()) {
      throw new Error(`검수 후보 criterion source span 누락: ${row.questionId}`);
    }
    return {
      grant: {
        id: row.grantId,
        title: row.grantTitle,
        source: row.grantSource,
        sourceId: row.grantSourceId,
        url: row.grantUrl,
        applyStart: row.grantApplyStart?.toISOString() ?? null,
        applyEnd: row.grantApplyEnd?.toISOString() ?? null,
      },
      question: {
        id: row.questionId,
        grantId: row.questionGrantId,
        criterionId: row.criterionId,
        evaluationContractVersion: row.questionEvaluationContractVersion,
        sourceRevisionSha256: row.questionSourceRevisionSha256,
        sourceRawSha256: row.questionSourceRawSha256,
        criterionStableKey: row.questionCriterionStableKey,
        definitionSha256: row.questionDefinitionSha256,
        version: row.questionVersion,
        prompt: row.questionPrompt,
        options: row.questionOptions,
        answerType: row.questionAnswerType,
        reusable: row.questionReusable,
        conditionKey: row.questionConditionKey,
        promptVersion: row.questionPromptVersion,
        provenance: row.questionProvenance,
        createdAt: row.questionCreatedAt.toISOString(),
      },
      criterion: {
        id: row.criterionId,
        stableKey: row.criterionStableKey,
        dimension: row.criterionDimension,
        kind: row.criterionKind,
        operator: row.criterionOperator,
        value: row.criterionValue,
        confidence: row.criterionConfidence,
        sourceSpan: row.criterionSourceSpan.trim(),
        sourceField: row.criterionSourceField,
        needsReview: row.criterionNeedsReview,
        parserVersion: row.criterionParserVersion,
      },
    };
  });
  return buildLegacyQuestionMigrationReviewBundle({ shadowReport, details });
}

export function serializeLegacyQuestionMigrationReviewPacket(
  packet: LegacyQuestionMigrationReviewPacket,
): Buffer {
  assertPacketHash(packet);
  return Buffer.from(`${JSON.stringify(packet, null, 2)}\n`, "utf8");
}

export function serializeLegacyQuestionMigrationReviewManifest(
  manifest: LegacyQuestionMigrationReviewManifest,
): Buffer {
  const { contentSha256, ...body } = manifest;
  if (contentSha256 !== sha256(stableJson(body))) {
    throw new Error("이관 검수 manifest content SHA가 내용과 일치하지 않습니다.");
  }
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function assertDetailBinding(
  entry: LegacyQuestionMigrationShadowEntry,
  detail: LegacyQuestionMigrationReviewDetail,
): void {
  if (
    detail.question.id !== entry.questionId
    || detail.question.grantId !== entry.grantId
    || detail.grant.id !== entry.grantId
    || detail.question.criterionId !== entry.criterionId
    || detail.criterion.id !== entry.criterionId
    || detail.question.evaluationContractVersion !== entry.evaluationContractVersion
    || detail.question.definitionSha256 !== entry.definitionSha256
    || detail.question.reusable !== entry.reusable
    || detail.criterion.stableKey !== entry.criterionStableKey
    || detail.criterion.dimension !== entry.criterionDimension
    || detail.criterion.kind !== entry.criterionKind
    || detail.criterion.operator !== entry.criterionOperator
  ) {
    throw new Error(`shadow와 검수 detail 결속이 다릅니다: ${entry.questionId}`);
  }
  if (
    !entry.currentSourceRevisionSha256
    || !entry.currentSourceRawSha256
    || !isSha256(entry.currentSourceRevisionSha256)
    || !isSha256(entry.currentSourceRawSha256)
  ) {
    throw new Error(`검수 후보의 current source 결속이 없습니다: ${entry.questionId}`);
  }
  if (
    detail.question.evaluationContractVersion !== null
    || detail.criterion.needsReview
    || !detail.criterion.sourceSpan.trim()
  ) {
    throw new Error(`legacy 검수 후보의 구조가 packet 계약을 충족하지 않습니다: ${entry.questionId}`);
  }
}

function assertPacketHash(packet: LegacyQuestionMigrationReviewPacket): void {
  const { contentSha256, ...body } = packet;
  if (contentSha256 !== sha256(stableJson(body))) {
    throw new Error("이관 검수 packet content SHA가 내용과 일치하지 않습니다.");
  }
}

function assertShadowReportHash(report: LegacyQuestionMigrationShadowReport): void {
  const { snapshotSha256, ...body } = report;
  if (snapshotSha256 !== sha256(stableJson(body))) {
    throw new Error("legacy 질문 이관 shadow snapshot SHA가 내용과 일치하지 않습니다.");
  }
}

function isReviewCandidate(entry: LegacyQuestionMigrationShadowEntry): boolean {
  return entry.disposition === "legacy_review_candidate"
    || entry.disposition === "legacy_answer_preservation_review";
}

function reviewAuthority(): LegacyQuestionMigrationReviewPacketBody["authority"] {
  return Object.freeze({
    status: "human_review_required" as const,
    modelCallsMade: 0 as const,
    serviceDatabaseWritesMade: 0 as const,
    migrationAuthorized: false as const,
    releaseAuthorized: false as const,
    liveQuestionWriteAuthorized: false as const,
  });
}

function shadowBinding(report: LegacyQuestionMigrationShadowReport) {
  return Object.freeze({
    schema: report.schema,
    snapshotSha256: report.snapshotSha256,
    observedAt: report.observedAt,
  });
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) throw new Error(`${label} ID가 중복됐습니다: ${id}`);
    result.set(id, value);
  }
  return result;
}

function canonicalIso(value: unknown, label: string): string {
  try {
    if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label}가 canonical ISO 시각이 아닙니다.`);
  }
  return value as string;
}

function fail(message: string): never {
  throw new Error(message);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

import { createHash } from "node:crypto";
import {
  canonicalLegacyQuestionMigrationReviewJson,
  legacyQuestionMigrationReviewDecisionSetBody,
  legacyQuestionMigrationReviewManifestBody,
  legacyQuestionMigrationReviewPacketBody,
  parseLegacyQuestionMigrationReviewDecisionSet,
  parseLegacyQuestionMigrationReviewManifest,
  parseLegacyQuestionMigrationReviewPacket,
  type LegacyQuestionMigrationReviewDecision,
  type LegacyQuestionMigrationReviewDecisionSet,
  type LegacyQuestionMigrationReviewManifest,
  type LegacyQuestionMigrationReviewPacket,
  type LegacyQuestionMigrationResolutionScope,
} from "@cunote/contracts/legacy-question-migration-review";
import { buildCompanyFactReuseIdentity } from "../matches/companyFactReuse";
import { questionDefinitionSha256 } from "../analysis-lab/promote";
import { validateLegacyQuestionMigrationReviewDecision } from "./legacyQuestionMigrationReviewPacket";

export const LEGACY_QUESTION_MIGRATION_DRAFT_SET_SCHEMA =
  "legacy-question-migration-draft-set-v1" as const;
export const LEGACY_QUESTION_MIGRATION_DRAFT_GENERATOR_VERSION =
  "deterministic-legacy-question-migration-draft-v1" as const;

type MigrationQuestionOption = Readonly<{
  value: "yes" | "no" | "unknown";
  label: string;
  evaluation: "satisfied" | "unsatisfied" | "unknown";
}>;

export interface LegacyQuestionMigrationDraftItem {
  readonly grantId: string;
  readonly questionId: string;
  readonly criterionId: string;
  readonly packetContentSha256: string;
  readonly candidateSha256: string;
  readonly sourceRevisionSha256: string;
  readonly sourceRawSha256: string;
  readonly criterionSha256: string;
  readonly criterion: LegacyQuestionMigrationReviewPacket["criterion"];
  readonly resolutionScope: LegacyQuestionMigrationResolutionScope;
  readonly answerPreservation: {
    readonly required: boolean;
    readonly answerCount: number;
    readonly answeringCompanyCount: number;
  };
  readonly question: {
    readonly prompt: string;
    readonly answerType: "single";
    readonly options: readonly [MigrationQuestionOption, MigrationQuestionOption, MigrationQuestionOption];
    readonly reusable: LegacyQuestionMigrationResolutionScope;
    readonly conditionKey: string | null;
    readonly evaluationContractVersion: "confirmation-evaluation-v2";
    readonly definitionSha256: string;
  };
}

export type LegacyQuestionMigrationNextWorkAction =
  | "refresh_review"
  | "repair_criterion"
  | "retire_legacy_question"
  | "register_company_fact_key";

export interface LegacyQuestionMigrationNextWorkItem {
  readonly grantId: string;
  readonly questionId: string;
  readonly criterionId: string;
  readonly packetContentSha256: string;
  readonly candidateSha256: string;
  readonly action: LegacyQuestionMigrationNextWorkAction;
  readonly reason:
    | "current_candidate_missing"
    | "current_candidate_changed"
    | "human_requested_criterion_repair"
    | "human_requested_legacy_retirement"
    | "verified_company_fact_key_missing";
  readonly reviewNote: string | null;
}

export interface LegacyQuestionMigrationDraftSetBody {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_DRAFT_SET_SCHEMA;
  readonly generatorVersion: typeof LEGACY_QUESTION_MIGRATION_DRAFT_GENERATOR_VERSION;
  readonly authority: {
    readonly status: "offline_draft_only";
    readonly modelCallsMade: 0;
    readonly serviceDatabaseWritesMade: 0;
    readonly migrationAuthorized: false;
    readonly releaseAuthorized: false;
    readonly promotionAuthorized: false;
    readonly liveQuestionWriteAuthorized: false;
  };
  readonly source: {
    readonly reviewManifestContentSha256: string;
    readonly decisionSetContentSha256: string;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
    readonly reviewShadowSnapshotSha256: string;
    readonly currentManifestContentSha256: string;
    readonly currentShadowSnapshotSha256: string;
  };
  readonly drafts: readonly LegacyQuestionMigrationDraftItem[];
  readonly nextWork: readonly LegacyQuestionMigrationNextWorkItem[];
}

export interface LegacyQuestionMigrationDraftSet
  extends LegacyQuestionMigrationDraftSetBody {
  readonly contentSha256: string;
}

export interface LegacyQuestionMigrationReviewBundleInput {
  readonly manifest: LegacyQuestionMigrationReviewManifest;
  readonly packets: readonly LegacyQuestionMigrationReviewPacket[];
}

/**
 * 과거 검수 packet/결정과 현재 repeatable-read packet을 다시 결속해 쓰기 권한 없는 v2 초안을 만든다.
 * LabRun이나 criterion review 이력을 합성하지 않으며, current bundle에서 의미가 달라진 항목은 격리한다.
 */
export function buildLegacyQuestionMigrationDraftSet(input: {
  readonly review: LegacyQuestionMigrationReviewBundleInput;
  readonly decisions: LegacyQuestionMigrationReviewDecisionSet;
  readonly current: LegacyQuestionMigrationReviewBundleInput;
}): LegacyQuestionMigrationDraftSet {
  const review = validateBundle(input.review, "review");
  const current = validateBundle(input.current, "current");
  const decisions = validateDecisionSet(input.decisions);
  if (
    decisions.manifestContentSha256 !== review.manifest.contentSha256
    || decisions.shadowSnapshotSha256 !== review.manifest.shadow.snapshotSha256
  ) {
    throw new Error("이관 결정 세트가 review manifest와 exact binding되지 않았습니다.");
  }

  const reviewPackets = new Map(review.packets.map((packet) => [packet.legacyQuestion.id, packet]));
  if (decisions.decisions.length !== reviewPackets.size) {
    throw new Error("이관 결정 세트는 exact manifest의 모든 질문을 한 번씩 판정해야 합니다.");
  }
  const decisionByQuestion = uniqueMap(
    decisions.decisions,
    (decision) => decision.questionId,
    "decision",
  );
  for (const questionId of reviewPackets.keys()) {
    if (!decisionByQuestion.has(questionId)) {
      throw new Error(`이관 결정 누락: ${questionId}`);
    }
  }

  const currentPackets = new Map(current.packets.map((packet) => [packet.legacyQuestion.id, packet]));
  const drafts: LegacyQuestionMigrationDraftItem[] = [];
  const nextWork: LegacyQuestionMigrationNextWorkItem[] = [];
  for (const questionId of [...reviewPackets.keys()].sort()) {
    const packet = reviewPackets.get(questionId)!;
    const decision = validateLegacyQuestionMigrationReviewDecision({
      packet,
      decision: decisionByQuestion.get(questionId),
    });
    const currentPacket = currentPackets.get(questionId);
    if (!currentPacket) {
      nextWork.push(nextWorkItem(packet, decision, "refresh_review", "current_candidate_missing"));
      continue;
    }
    if (currentPacket.candidateSha256 !== packet.candidateSha256) {
      nextWork.push(nextWorkItem(packet, decision, "refresh_review", "current_candidate_changed"));
      continue;
    }
    if (decision.verdict === "repair_criterion") {
      requireFollowUpNote(decision);
      nextWork.push(nextWorkItem(
        packet,
        decision,
        "repair_criterion",
        "human_requested_criterion_repair",
      ));
      continue;
    }
    if (decision.verdict === "retire_legacy_question") {
      requireFollowUpNote(decision);
      nextWork.push(nextWorkItem(
        packet,
        decision,
        "retire_legacy_question",
        "human_requested_legacy_retirement",
      ));
      continue;
    }
    if (!decision.resolutionScope || !decision.confirmedPolarity) {
      throw new Error(`승인 결정의 극성 또는 해소 범위가 없습니다: ${questionId}`);
    }
    const conditionKey = companyFactConditionKey(packet, decision.resolutionScope);
    if (decision.resolutionScope === "company_fact" && !conditionKey) {
      nextWork.push(nextWorkItem(
        packet,
        decision,
        "register_company_fact_key",
        "verified_company_fact_key_missing",
      ));
      continue;
    }
    const draft = buildDraftItem(packet, decision, conditionKey);
    if (decision.resolutionScope === "company_fact" && !buildCompanyFactReuseIdentity({
      questionId: packet.legacyQuestion.id,
      grantId: packet.grant.id,
      reusable: draft.question.reusable,
      conditionKey: draft.question.conditionKey,
      evaluationContractVersion: draft.question.evaluationContractVersion,
      answerType: draft.question.answerType,
      options: draft.question.options,
      criterion: {
        dimension: packet.criterion.dimension,
        kind: packet.criterion.kind,
        operator: packet.criterion.operator,
        value: packet.criterion.value,
      },
    })) {
      nextWork.push(nextWorkItem(
        packet,
        decision,
        "register_company_fact_key",
        "verified_company_fact_key_missing",
      ));
      continue;
    }
    drafts.push(draft);
  }

  const reviewer = decisions.decisions[0]!.reviewerEmail;
  const body: LegacyQuestionMigrationDraftSetBody = {
    schema: LEGACY_QUESTION_MIGRATION_DRAFT_SET_SCHEMA,
    generatorVersion: LEGACY_QUESTION_MIGRATION_DRAFT_GENERATOR_VERSION,
    authority: {
      status: "offline_draft_only",
      modelCallsMade: 0,
      serviceDatabaseWritesMade: 0,
      migrationAuthorized: false,
      releaseAuthorized: false,
      promotionAuthorized: false,
      liveQuestionWriteAuthorized: false,
    },
    source: {
      reviewManifestContentSha256: review.manifest.contentSha256,
      decisionSetContentSha256: decisions.contentSha256,
      reviewedBy: reviewer,
      reviewedAt: decisions.createdAt,
      reviewShadowSnapshotSha256: review.manifest.shadow.snapshotSha256,
      currentManifestContentSha256: current.manifest.contentSha256,
      currentShadowSnapshotSha256: current.manifest.shadow.snapshotSha256,
    },
    drafts,
    nextWork,
  };
  return Object.freeze({ ...body, contentSha256: sha256(canonical(body)) });
}

export function serializeLegacyQuestionMigrationDraftSet(
  draftSet: LegacyQuestionMigrationDraftSet,
): Buffer {
  const { contentSha256, ...body } = draftSet;
  if (contentSha256 !== sha256(canonical(body))) {
    throw new Error("이관 draft set content SHA가 내용과 일치하지 않습니다.");
  }
  return Buffer.from(`${JSON.stringify(draftSet, null, 2)}\n`, "utf8");
}

function validateBundle(
  input: LegacyQuestionMigrationReviewBundleInput,
  label: string,
): LegacyQuestionMigrationReviewBundleInput {
  const manifest = parseLegacyQuestionMigrationReviewManifest(input.manifest);
  if (manifest.contentSha256 !== sha256(canonical(legacyQuestionMigrationReviewManifestBody(manifest)))) {
    throw new Error(`${label} manifest content SHA가 내용과 일치하지 않습니다.`);
  }
  if (input.packets.length !== manifest.packetCount) {
    throw new Error(`${label} manifest packetCount와 packet 수가 다릅니다.`);
  }
  const packets = input.packets.map(parseLegacyQuestionMigrationReviewPacket);
  const packetByQuestion = uniqueMap(packets, (packet) => packet.legacyQuestion.id, `${label} packet`);
  for (const packet of packets) {
    if (packet.contentSha256 !== sha256(canonical(legacyQuestionMigrationReviewPacketBody(packet)))) {
      throw new Error(`${label} packet content SHA가 내용과 일치하지 않습니다: ${packet.legacyQuestion.id}`);
    }
    if (
      packet.shadow.snapshotSha256 !== manifest.shadow.snapshotSha256
      || packet.shadow.observedAt !== manifest.shadow.observedAt
    ) {
      throw new Error(`${label} packet의 shadow binding이 manifest와 다릅니다.`);
    }
  }
  for (const entry of manifest.packets) {
    const packet = packetByQuestion.get(entry.questionId);
    if (
      !packet
      || entry.grantId !== packet.grant.id
      || entry.criterionId !== packet.criterion.id
      || entry.candidateSha256 !== packet.candidateSha256
      || entry.packetContentSha256 !== packet.contentSha256
      || entry.fileName !== `${packet.legacyQuestion.id}.${packet.contentSha256}.json`
    ) {
      throw new Error(`${label} manifest entry와 packet 결속이 다릅니다: ${entry.questionId}`);
    }
  }
  return { manifest, packets };
}

function validateDecisionSet(
  input: LegacyQuestionMigrationReviewDecisionSet,
): LegacyQuestionMigrationReviewDecisionSet {
  const decisions = parseLegacyQuestionMigrationReviewDecisionSet(input);
  if (decisions.contentSha256 !== sha256(canonical(
    legacyQuestionMigrationReviewDecisionSetBody(decisions),
  ))) {
    throw new Error("이관 결정 세트 content SHA가 내용과 일치하지 않습니다.");
  }
  return decisions;
}

function buildDraftItem(
  packet: LegacyQuestionMigrationReviewPacket,
  decision: LegacyQuestionMigrationReviewDecision,
  conditionKey: string | null,
): LegacyQuestionMigrationDraftItem {
  const resolutionScope = decision.resolutionScope!;
  const criterionSha256 = sha256(canonical(packet.criterion));
  const exclusion = decision.confirmedPolarity === "exclusion_membership";
  const industry = packet.criterion.dimension === "industry";
  const kindLabel = packet.criterion.kind === "preferred" ? "우대" : exclusion ? "제외" : "필수";
  const prompt = industry
    ? `귀사의 취급 제품·서비스가 다음 공고 분야에 해당하나요?\n\n“${packet.criterion.sourceSpan}”`
    : `다음 ${kindLabel} 조건${exclusion ? "에 해당하나요" : "을 충족하나요"}?\n\n“${packet.criterion.sourceSpan}”`;
  const options: LegacyQuestionMigrationDraftItem["question"]["options"] = exclusion
      ? [
          { value: "yes", label: "해당해요", evaluation: "unsatisfied" },
          { value: "no", label: "해당하지 않아요", evaluation: "satisfied" },
          { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
        ]
      : [
          { value: "yes", label: industry ? "해당해요" : "충족해요", evaluation: "satisfied" },
          { value: "no", label: industry ? "해당하지 않아요" : "충족하지 않아요", evaluation: "unsatisfied" },
          { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
        ];
  const definition = {
    prompt,
    answerType: "single" as const,
    options,
    reusable: resolutionScope,
    conditionKey,
    evaluationContractVersion: "confirmation-evaluation-v2" as const,
    sourceRevisionSha256: packet.currentSource.sourceRevisionSha256,
    sourceRawSha256: packet.currentSource.sourceRawSha256,
  };
  return {
    grantId: packet.grant.id,
    questionId: packet.legacyQuestion.id,
    criterionId: packet.criterion.id,
    packetContentSha256: packet.contentSha256,
    candidateSha256: packet.candidateSha256,
    sourceRevisionSha256: packet.currentSource.sourceRevisionSha256,
    sourceRawSha256: packet.currentSource.sourceRawSha256,
    criterionSha256,
    criterion: packet.criterion,
    resolutionScope,
    answerPreservation: {
      required: packet.legacyQuestion.answerCount > 0,
      answerCount: packet.legacyQuestion.answerCount,
      answeringCompanyCount: packet.legacyQuestion.answeringCompanyCount,
    },
    question: {
      prompt,
      answerType: "single",
      options,
      reusable: resolutionScope,
      conditionKey,
      evaluationContractVersion: "confirmation-evaluation-v2",
      definitionSha256: questionDefinitionSha256({
        ...definition,
        options: [...definition.options],
      }),
    },
  };
}

function requireFollowUpNote(decision: LegacyQuestionMigrationReviewDecision): void {
  if (!decision.note?.trim()) {
    throw new Error("조건 수리·기존 질문 폐기 결정에는 후속 작업 메모가 필요합니다.");
  }
}

function nextWorkItem(
  packet: LegacyQuestionMigrationReviewPacket,
  decision: LegacyQuestionMigrationReviewDecision,
  action: LegacyQuestionMigrationNextWorkAction,
  reason: LegacyQuestionMigrationNextWorkItem["reason"],
): LegacyQuestionMigrationNextWorkItem {
  return {
    grantId: packet.grant.id,
    questionId: packet.legacyQuestion.id,
    criterionId: packet.criterion.id,
    packetContentSha256: packet.contentSha256,
    candidateSha256: packet.candidateSha256,
    action,
    reason,
    reviewNote: decision.note,
  };
}

function companyFactConditionKey(
  packet: LegacyQuestionMigrationReviewPacket,
  scope: LegacyQuestionMigrationResolutionScope,
): string | null {
  if (scope !== "company_fact") return null;
  const conditionKey = packet.legacyQuestion.conditionKey?.normalize("NFC").trim() ?? "";
  if (
    packet.legacyQuestion.reusable !== "company_fact"
    || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(conditionKey)
  ) return null;
  return conditionKey;
}

function uniqueMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) throw new Error(`${label} 중복: ${key}`);
    result.set(key, value);
  }
  return result;
}

function canonical(value: unknown): string {
  return canonicalLegacyQuestionMigrationReviewJson(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

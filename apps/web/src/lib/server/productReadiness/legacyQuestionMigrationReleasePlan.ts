import { createHash } from "node:crypto";
import { canonicalLegacyQuestionMigrationReviewJson } from "@cunote/contracts/legacy-question-migration-review";
import {
  questionDefinitionSha256,
  sourceSpanHash,
} from "../analysis-lab/promote";
import {
  validateLegacyQuestionMigrationDraftSet,
  validateLegacyQuestionMigrationReviewBundle,
  type LegacyQuestionMigrationDraftItem,
  type LegacyQuestionMigrationDraftSet,
  type LegacyQuestionMigrationReviewBundleInput,
} from "./legacyQuestionMigrationDraft";

export const LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA =
  "legacy-question-migration-release-plan-v1" as const;
export const LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION =
  "legacy-question-migration-draft-v1" as const;

export interface LegacyQuestionMigrationReleaseOperation {
  readonly grantId: string;
  readonly criterionId: string;
  readonly criterionStableKey: string;
  readonly legacyQuestion: {
    readonly id: string;
    readonly version: number;
    readonly definitionSha256: string;
    readonly expectedAnswerCount: 0;
  };
  readonly question: {
    readonly definitionSha256: string;
    readonly sourceRevisionSha256: string;
    readonly sourceRawSha256: string;
    readonly criterionStableKey: string;
    readonly criterionRef: {
      readonly dimension: string;
      readonly kind: string;
      readonly sourceSpanHash: string;
    };
    readonly prompt: string;
    readonly options: LegacyQuestionMigrationDraftItem["question"]["options"];
    readonly answerType: "single";
    readonly reusable: LegacyQuestionMigrationDraftItem["question"]["reusable"];
    readonly conditionKey: string | null;
    readonly evaluationContractVersion: "confirmation-evaluation-v2";
    readonly promptVer: typeof LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION;
    readonly supersedesQuestionId: string;
    readonly minimumVersion: number;
    readonly provenance: {
      readonly schema: "legacy-question-migration-provenance-v1";
      readonly draftSetContentSha256: string;
      readonly decisionSetContentSha256: string;
      readonly packetContentSha256: string;
      readonly candidateSha256: string;
      readonly reviewerEmail: string;
      readonly reviewedAt: string;
    };
  };
  readonly retireLegacy: {
    readonly questionId: string;
    readonly invalidationReason: "legacy_question_migrated_to_v2";
  };
}

export interface LegacyQuestionMigrationReleaseHold {
  readonly grantId: string;
  readonly questionId: string;
  readonly criterionId: string;
  readonly reason: "answer_preservation_review_required";
  readonly answerCount: number;
  readonly answeringCompanyCount: number;
}

export interface LegacyQuestionMigrationReleasePlanBody {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA;
  readonly authority: {
    readonly status: "offline_write_plan_only";
    readonly serviceDatabaseWritesMade: 0;
    readonly migrationAuthorized: false;
    readonly releaseAuthorized: false;
    readonly promotionAuthorized: false;
    readonly liveQuestionWriteAuthorized: false;
  };
  readonly source: {
    readonly draftSetContentSha256: string;
    readonly decisionSetContentSha256: string;
    readonly currentManifestContentSha256: string;
    readonly currentShadowSnapshotSha256: string;
  };
  readonly operations: readonly LegacyQuestionMigrationReleaseOperation[];
  readonly holds: readonly LegacyQuestionMigrationReleaseHold[];
  readonly inheritedNextWorkCount: number;
}

export interface LegacyQuestionMigrationReleasePlan
  extends LegacyQuestionMigrationReleasePlanBody {
  readonly contentSha256: string;
}

/**
 * 기존 promotion writer의 전체 grant 교체 동작을 재사용하지 않고, 질문 한 건의 제한 이관에
 * 필요한 exact operation만 만든다. 이 함수와 산출물은 실제 쓰기 권한을 부여하지 않는다.
 */
export function buildLegacyQuestionMigrationReleasePlan(input: {
  readonly draftSet: LegacyQuestionMigrationDraftSet;
  readonly current: LegacyQuestionMigrationReviewBundleInput;
}): LegacyQuestionMigrationReleasePlan {
  const draftSet = validateLegacyQuestionMigrationDraftSet(input.draftSet);
  const current = validateLegacyQuestionMigrationReviewBundle(input.current, "release current");
  if (
    draftSet.source.currentManifestContentSha256 !== current.manifest.contentSha256
    || draftSet.source.currentShadowSnapshotSha256 !== current.manifest.shadow.snapshotSha256
  ) {
    throw new Error("이관 draft와 release current snapshot이 exact binding되지 않았습니다.");
  }
  const currentByQuestion = new Map(
    current.packets.map((packet) => [packet.legacyQuestion.id, packet]),
  );
  const operations: LegacyQuestionMigrationReleaseOperation[] = [];
  const holds: LegacyQuestionMigrationReleaseHold[] = [];
  for (const draft of [...draftSet.drafts].sort((left, right) =>
    left.questionId.localeCompare(right.questionId))) {
    const packet = currentByQuestion.get(draft.questionId);
    if (
      !packet
      || packet.contentSha256 !== draft.packetContentSha256
      || packet.candidateSha256 !== draft.candidateSha256
      || packet.grant.id !== draft.grantId
      || packet.criterion.id !== draft.criterionId
    ) {
      throw new Error(`이관 draft의 current packet 결속이 다릅니다: ${draft.questionId}`);
    }
    assertDraftDefinition(draft);
    if (
      draft.answerPreservation.required
      || draft.answerPreservation.answerCount > 0
      || packet.legacyQuestion.answerCount > 0
    ) {
      holds.push({
        grantId: draft.grantId,
        questionId: draft.questionId,
        criterionId: draft.criterionId,
        reason: "answer_preservation_review_required",
        answerCount: packet.legacyQuestion.answerCount,
        answeringCompanyCount: packet.legacyQuestion.answeringCompanyCount,
      });
      continue;
    }
    const criterionStableKey = packet.criterion.stableKey?.trim();
    const spanHash = sourceSpanHash(packet.criterion.sourceSpan);
    if (!criterionStableKey || !spanHash) {
      throw new Error(`이관 release operation의 criterion 결속이 부족합니다: ${draft.questionId}`);
    }
    operations.push({
      grantId: draft.grantId,
      criterionId: draft.criterionId,
      criterionStableKey,
      legacyQuestion: {
        id: packet.legacyQuestion.id,
        version: packet.legacyQuestion.version,
        definitionSha256: packet.legacyQuestion.definitionSha256,
        expectedAnswerCount: 0,
      },
      question: {
        definitionSha256: draft.question.definitionSha256,
        sourceRevisionSha256: draft.sourceRevisionSha256,
        sourceRawSha256: draft.sourceRawSha256,
        criterionStableKey,
        criterionRef: {
          dimension: packet.criterion.dimension,
          kind: packet.criterion.kind,
          sourceSpanHash: spanHash,
        },
        prompt: draft.question.prompt,
        options: draft.question.options,
        answerType: "single",
        reusable: draft.question.reusable,
        conditionKey: draft.question.conditionKey,
        evaluationContractVersion: "confirmation-evaluation-v2",
        promptVer: LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION,
        supersedesQuestionId: packet.legacyQuestion.id,
        minimumVersion: packet.legacyQuestion.version + 1,
        provenance: {
          schema: "legacy-question-migration-provenance-v1",
          draftSetContentSha256: draftSet.contentSha256,
          decisionSetContentSha256: draftSet.source.decisionSetContentSha256,
          packetContentSha256: draft.packetContentSha256,
          candidateSha256: draft.candidateSha256,
          reviewerEmail: draftSet.source.reviewedBy,
          reviewedAt: draftSet.source.reviewedAt,
        },
      },
      retireLegacy: {
        questionId: packet.legacyQuestion.id,
        invalidationReason: "legacy_question_migrated_to_v2",
      },
    });
  }
  const body: LegacyQuestionMigrationReleasePlanBody = {
    schema: LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA,
    authority: {
      status: "offline_write_plan_only",
      serviceDatabaseWritesMade: 0,
      migrationAuthorized: false,
      releaseAuthorized: false,
      promotionAuthorized: false,
      liveQuestionWriteAuthorized: false,
    },
    source: {
      draftSetContentSha256: draftSet.contentSha256,
      decisionSetContentSha256: draftSet.source.decisionSetContentSha256,
      currentManifestContentSha256: current.manifest.contentSha256,
      currentShadowSnapshotSha256: current.manifest.shadow.snapshotSha256,
    },
    operations,
    holds,
    inheritedNextWorkCount: draftSet.nextWork.length,
  };
  return Object.freeze({ ...body, contentSha256: sha256(canonical(body)) });
}

export function serializeLegacyQuestionMigrationReleasePlan(
  plan: LegacyQuestionMigrationReleasePlan,
): Buffer {
  const { contentSha256, ...body } = plan;
  if (contentSha256 !== sha256(canonical(body))) {
    throw new Error("이관 release plan content SHA가 내용과 일치하지 않습니다.");
  }
  return Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

function assertDraftDefinition(draft: LegacyQuestionMigrationDraftItem): void {
  const expected = questionDefinitionSha256({
    prompt: draft.question.prompt,
    options: [...draft.question.options],
    answerType: draft.question.answerType,
    reusable: draft.question.reusable,
    conditionKey: draft.question.conditionKey,
    evaluationContractVersion: draft.question.evaluationContractVersion,
    sourceRevisionSha256: draft.sourceRevisionSha256,
    sourceRawSha256: draft.sourceRawSha256,
  });
  if (draft.question.definitionSha256 !== expected) {
    throw new Error(`이관 draft 질문 definition SHA가 다릅니다: ${draft.questionId}`);
  }
}

function canonical(value: unknown): string {
  return canonicalLegacyQuestionMigrationReviewJson(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA,
  LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
  LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
  canonicalLegacyQuestionMigrationReviewJson,
  type LegacyQuestionMigrationReviewDecision,
  type LegacyQuestionMigrationReviewDecisionSet,
  type LegacyQuestionMigrationReviewDecisionSetBody,
  type LegacyQuestionMigrationReviewManifest,
  type LegacyQuestionMigrationReviewManifestBody,
  type LegacyQuestionMigrationReviewPacket,
  type LegacyQuestionMigrationReviewPacketBody,
} from "@cunote/contracts/legacy-question-migration-review";
import {
  buildLegacyQuestionMigrationDraftSet,
  serializeLegacyQuestionMigrationDraftSet,
} from "./legacyQuestionMigrationDraft";
import {
  buildLegacyQuestionMigrationReleasePlan,
  serializeLegacyQuestionMigrationReleasePlan,
} from "./legacyQuestionMigrationReleasePlan";

const reviewedAt = "2026-09-22T09:00:00.000Z";

test("exact 사람 승인과 현재 후보가 같으면 기존 release 의미 해시를 가진 offline v2 초안이 된다", () => {
  const first = fixture({ suffix: "1", reusable: "per_notice", answerCount: 2, industry: true });
  const decisions = decisionSet(first.manifest, [decision(first.packet, {
    verdict: "approve_for_v2_draft",
    confirmedPolarity: "exclusion_membership",
    resolutionScope: "per_notice",
  })]);
  const built = buildLegacyQuestionMigrationDraftSet({
    review: { manifest: first.manifest, packets: [first.packet] },
    decisions,
    current: { manifest: first.manifest, packets: [first.packet] },
  });
  assert.equal(built.authority.serviceDatabaseWritesMade, 0);
  assert.equal(built.authority.releaseAuthorized, false);
  assert.equal(built.drafts.length, 1);
  assert.equal(built.nextWork.length, 0);
  assert.deepEqual(built.drafts[0]?.question.options.map((option) => option.evaluation), [
    "unsatisfied", "satisfied", "unknown",
  ]);
  assert.equal(built.drafts[0]?.question.reusable, "per_notice");
  assert.equal(built.drafts[0]?.question.conditionKey, null);
  assert.equal(built.drafts[0]?.answerPreservation.required, true);
  assert.match(built.drafts[0]?.question.definitionSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => serializeLegacyQuestionMigrationDraftSet(built));
  assert.equal(
    buildLegacyQuestionMigrationDraftSet({
      review: { manifest: first.manifest, packets: [first.packet] },
      decisions,
      current: { manifest: first.manifest, packets: [first.packet] },
    }).contentSha256,
    built.contentSha256,
  );
});

test("검수된 기존 표준 키만 company_fact로 유지하고 키를 새로 추정하지 않는다", () => {
  const reusable = fixture({ suffix: "1", reusable: "company_fact", conditionKey: "prior_support_history" });
  const isolated = fixture({ suffix: "2", reusable: "per_notice", conditionKey: null });
  const review = combine([reusable.packet, isolated.packet]);
  const decisions = decisionSet(review.manifest, [
    decision(reusable.packet, {
      verdict: "approve_for_v2_draft",
      confirmedPolarity: "exclusion_membership",
      resolutionScope: "company_fact",
    }),
    decision(isolated.packet, {
      verdict: "approve_for_v2_draft",
      confirmedPolarity: "exclusion_membership",
      resolutionScope: "company_fact",
    }),
  ]);
  const built = buildLegacyQuestionMigrationDraftSet({ review, decisions, current: review });
  assert.equal(built.drafts.length, 1);
  assert.equal(built.drafts[0]?.question.conditionKey, "prior_support_history");
  assert.equal(built.nextWork.length, 1);
  assert.equal(built.nextWork[0]?.action, "register_company_fact_key");
});

test("현재 변경·누락과 사람 수리 결정은 target별 next work로 격리한다", () => {
  const approved = fixture({ suffix: "1" });
  const repair = fixture({ suffix: "2" });
  const missing = fixture({ suffix: "3" });
  const review = combine([approved.packet, repair.packet, missing.packet]);
  const decisions = decisionSet(review.manifest, [
    decision(approved.packet, {
      verdict: "approve_for_v2_draft",
      confirmedPolarity: "exclusion_membership",
      resolutionScope: "per_notice",
    }),
    decision(repair.packet, { verdict: "repair_criterion", note: "원문 조건 구조를 다시 확인" }),
    decision(missing.packet, {
      verdict: "approve_for_v2_draft",
      confirmedPolarity: "exclusion_membership",
      resolutionScope: "per_notice",
    }),
  ]);
  const changedRepair = readdressPacket(repair.packet, "f".repeat(64));
  const current = combine([approved.packet, changedRepair]);
  const built = buildLegacyQuestionMigrationDraftSet({ review, decisions, current });
  assert.equal(built.drafts.length, 1);
  assert.deepEqual(built.nextWork.map((item) => [item.questionId, item.reason]), [
    [repair.packet.legacyQuestion.id, "current_candidate_changed"],
    [missing.packet.legacyQuestion.id, "current_candidate_missing"],
  ]);
});

test("공유 artifact 변조·다른 묶음·잘못된 극성·메모 없는 수리를 거부한다", () => {
  const item = fixture({ suffix: "1" });
  const approved = decision(item.packet, {
    verdict: "approve_for_v2_draft",
    confirmedPolarity: "exclusion_membership",
    resolutionScope: "per_notice",
  });
  const exact = decisionSet(item.manifest, [approved]);
  const base = {
    review: { manifest: item.manifest, packets: [item.packet] },
    decisions: exact,
    current: { manifest: item.manifest, packets: [item.packet] },
  };
  assert.throws(() => buildLegacyQuestionMigrationDraftSet({
    ...base,
    review: { ...base.review, packets: [{ ...item.packet, grant: { ...item.packet.grant, title: "변조" } }] },
  }), /packet content SHA/);
  assert.throws(() => buildLegacyQuestionMigrationDraftSet({
    ...base,
    decisions: decisionSet(item.manifest, [{ ...approved, confirmedPolarity: "criterion_satisfaction" }]),
  }), /극성/);
  assert.throws(() => buildLegacyQuestionMigrationDraftSet({
    ...base,
    decisions: readdressDecisionSet(exact, { manifestContentSha256: "0".repeat(64) }),
  }), /review manifest/);
  assert.throws(() => buildLegacyQuestionMigrationDraftSet({
    ...base,
    decisions: decisionSet(item.manifest, [decision(item.packet, {
      verdict: "repair_criterion",
      note: null,
    })]),
  }), /후속 작업 메모/);
});

test("답변 없는 승인 초안만 제한된 v2 이관 operation으로 계획한다", () => {
  const item = fixture({ suffix: "1", answerCount: 0 });
  const review = { manifest: item.manifest, packets: [item.packet] };
  const draftSet = buildLegacyQuestionMigrationDraftSet({
    review,
    decisions: decisionSet(item.manifest, [decision(item.packet, {
      verdict: "approve_for_v2_draft",
      confirmedPolarity: "exclusion_membership",
      resolutionScope: "per_notice",
    })]),
    current: review,
  });
  const plan = buildLegacyQuestionMigrationReleasePlan({ draftSet, current: review });
  assert.equal(plan.authority.status, "offline_write_plan_only");
  assert.equal(plan.authority.serviceDatabaseWritesMade, 0);
  assert.equal(plan.authority.releaseAuthorized, false);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.holds.length, 0);
  assert.equal(plan.operations[0]?.question.supersedesQuestionId, item.packet.legacyQuestion.id);
  assert.equal(plan.operations[0]?.question.minimumVersion, 2);
  assert.equal(plan.operations[0]?.question.provenance.schema, "legacy-question-migration-provenance-v1");
  assert.equal("runId" in (plan.operations[0]?.question.provenance ?? {}), false);
  assert.doesNotThrow(() => serializeLegacyQuestionMigrationReleasePlan(plan));
});

test("기존 답변이 있는 질문은 자동 이관하지 않고 답변 보존 검수로 보낸다", () => {
  const item = fixture({ suffix: "1", answerCount: 3 });
  const review = { manifest: item.manifest, packets: [item.packet] };
  const draftSet = buildLegacyQuestionMigrationDraftSet({
    review,
    decisions: decisionSet(item.manifest, [decision(item.packet, {
      verdict: "approve_for_v2_draft",
      confirmedPolarity: "exclusion_membership",
      resolutionScope: "per_notice",
    })]),
    current: review,
  });
  const plan = buildLegacyQuestionMigrationReleasePlan({ draftSet, current: review });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.holds[0]?.reason, "answer_preservation_review_required");
  assert.equal(plan.holds[0]?.answerCount, 3);
  const other = fixture({ suffix: "2" });
  assert.throws(() => buildLegacyQuestionMigrationReleasePlan({
    draftSet,
    current: { manifest: other.manifest, packets: [other.packet] },
  }), /exact binding/);
});

function fixture(input: {
  suffix: string;
  reusable?: "company_fact" | "per_notice";
  conditionKey?: string | null;
  answerCount?: number;
  industry?: boolean;
}) {
  const suffix = input.suffix;
  const candidateSha256 = suffix.repeat(64).slice(0, 64);
  const questionId = `question-${suffix}`;
  const packetBody: LegacyQuestionMigrationReviewPacketBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
    authority: reviewAuthority(),
    shadow: {
      schema: "legacy-question-migration-shadow-v1",
      snapshotSha256: "a".repeat(64),
      observedAt: "2026-09-22T08:00:00.000Z",
    },
    candidateSha256,
    grant: {
      id: `grant-${suffix}`,
      title: `공고 ${suffix}`,
      source: "bizinfo",
      sourceId: `source-${suffix}`,
      url: `https://example.com/${suffix}`,
      applyStart: "2026-09-01T00:00:00.000Z",
      applyEnd: "2026-09-30T00:00:00.000Z",
    },
    currentSource: {
      sourceRevisionSha256: "b".repeat(64),
      sourceRawSha256: "c".repeat(64),
    },
    legacyQuestion: {
      id: questionId,
      grantId: `grant-${suffix}`,
      criterionId: `criterion-${suffix}`,
      evaluationContractVersion: null,
      sourceRevisionSha256: null,
      sourceRawSha256: null,
      criterionStableKey: `criterion:other:${suffix}`,
      definitionSha256: "legacy-v0",
      version: 1,
      prompt: "과거 지원사업 수혜 대상에 해당하나요?",
      options: [{ value: "yes", label: "예" }, { value: "no", label: "아니요" }],
      answerType: "single",
      reusable: input.reusable ?? "per_notice",
      conditionKey: input.conditionKey ?? null,
      promptVersion: "legacy-v1",
      provenance: { source: "legacy" },
      createdAt: "2026-08-01T00:00:00.000Z",
      answerCount: input.answerCount ?? 0,
      answeringCompanyCount: input.answerCount ? 1 : 0,
    },
    criterion: {
      id: `criterion-${suffix}`,
      stableKey: `criterion:other:${suffix}`,
      dimension: input.industry ? "industry" : "other",
      kind: "exclusion",
      operator: "text_only",
      value: { note: "과거 지원사업 수혜 기업은 제외" },
      confidence: 1,
      sourceSpan: "과거 지원사업 수혜 기업은 제외",
      sourceField: "qualification",
      needsReview: false,
      parserVersion: "deep-v1",
    },
    requiredReview: {
      allowedVerdicts: ["approve_for_v2_draft", "repair_criterion", "retire_legacy_question"],
      expectedPolarity: "exclusion_membership",
      allowedResolutionScopes: ["per_notice", "company_fact"],
      checks: ["원문 조건 확인"],
      decisionTemplate: {
        schema: "legacy-question-migration-review-decision-v1",
        packetContentSha256: null,
        candidateSha256,
        grantId: `grant-${suffix}`,
        questionId,
        criterionId: `criterion-${suffix}`,
        verdict: null,
        confirmedPolarity: null,
        resolutionScope: null,
        reviewerEmail: null,
        reviewedAt: null,
        note: null,
      },
    },
  };
  const packet: LegacyQuestionMigrationReviewPacket = {
    ...packetBody,
    contentSha256: hash(packetBody),
  };
  const combined = combine([packet]);
  return { packet, manifest: combined.manifest };
}

function combine(packets: LegacyQuestionMigrationReviewPacket[]) {
  const sorted = [...packets].sort((left, right) => left.legacyQuestion.id.localeCompare(right.legacyQuestion.id));
  const body: LegacyQuestionMigrationReviewManifestBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
    authority: reviewAuthority(),
    shadow: sorted[0]?.shadow ?? {
      schema: "legacy-question-migration-shadow-v1",
      snapshotSha256: "a".repeat(64),
      observedAt: "2026-09-22T08:00:00.000Z",
    },
    packetCount: sorted.length,
    answerPreservationReviewCount: sorted.filter((packet) => packet.legacyQuestion.answerCount > 0).length,
    packets: sorted.map((packet) => ({
      grantId: packet.grant.id,
      questionId: packet.legacyQuestion.id,
      criterionId: packet.criterion.id,
      candidateSha256: packet.candidateSha256,
      packetContentSha256: packet.contentSha256,
      fileName: `${packet.legacyQuestion.id}.${packet.contentSha256}.json`,
    })),
  };
  const manifest: LegacyQuestionMigrationReviewManifest = { ...body, contentSha256: hash(body) };
  return { manifest, packets: sorted };
}

function decision(
  packet: LegacyQuestionMigrationReviewPacket,
  input: {
    verdict: LegacyQuestionMigrationReviewDecision["verdict"];
    confirmedPolarity?: LegacyQuestionMigrationReviewDecision["confirmedPolarity"];
    resolutionScope?: LegacyQuestionMigrationReviewDecision["resolutionScope"];
    note?: string | null;
  },
): LegacyQuestionMigrationReviewDecision {
  return {
    schema: "legacy-question-migration-review-decision-v1",
    packetContentSha256: packet.contentSha256,
    candidateSha256: packet.candidateSha256,
    grantId: packet.grant.id,
    questionId: packet.legacyQuestion.id,
    criterionId: packet.criterion.id,
    verdict: input.verdict,
    confirmedPolarity: input.confirmedPolarity ?? null,
    resolutionScope: input.resolutionScope ?? null,
    reviewerEmail: "human.reviewer@example.com",
    reviewedAt,
    note: input.note ?? null,
  };
}

function decisionSet(
  manifest: LegacyQuestionMigrationReviewManifest,
  decisions: LegacyQuestionMigrationReviewDecision[],
): LegacyQuestionMigrationReviewDecisionSet {
  const body: LegacyQuestionMigrationReviewDecisionSetBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA,
    authority: {
      status: "human_review_record_only",
      serviceDatabaseWritesMade: 0,
      migrationAuthorized: false,
      releaseAuthorized: false,
      liveQuestionWriteAuthorized: false,
    },
    manifestContentSha256: manifest.contentSha256,
    shadowSnapshotSha256: manifest.shadow.snapshotSha256,
    createdAt: reviewedAt,
    decisions,
  };
  return { ...body, contentSha256: hash(body) };
}

function readdressPacket(
  packet: LegacyQuestionMigrationReviewPacket,
  candidateSha256: string,
): LegacyQuestionMigrationReviewPacket {
  const { contentSha256: _contentSha256, ...packetBody } = packet;
  const body: LegacyQuestionMigrationReviewPacketBody = {
    ...packetBody,
    candidateSha256,
    requiredReview: {
      ...packet.requiredReview,
      decisionTemplate: { ...packet.requiredReview.decisionTemplate, candidateSha256 },
    },
  };
  return { ...body, contentSha256: hash(body) };
}

function readdressDecisionSet(
  set: LegacyQuestionMigrationReviewDecisionSet,
  update: Partial<LegacyQuestionMigrationReviewDecisionSetBody>,
): LegacyQuestionMigrationReviewDecisionSet {
  const { contentSha256: _contentSha256, ...previous } = set;
  const body = { ...previous, ...update } as LegacyQuestionMigrationReviewDecisionSetBody;
  return { ...body, contentSha256: hash(body) };
}

function reviewAuthority() {
  return {
    status: "human_review_required" as const,
    modelCallsMade: 0 as const,
    serviceDatabaseWritesMade: 0 as const,
    migrationAuthorized: false as const,
    releaseAuthorized: false as const,
    liveQuestionWriteAuthorized: false as const,
  };
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalLegacyQuestionMigrationReviewJson(value))
    .digest("hex");
}

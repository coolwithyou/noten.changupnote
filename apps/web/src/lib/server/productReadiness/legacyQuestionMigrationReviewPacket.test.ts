import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyQuestionMigrationShadowReport,
  type LegacyQuestionMigrationShadowInput,
} from "./legacyQuestionMigrationShadow";
import {
  LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
  buildLegacyQuestionMigrationReviewBundle,
  serializeLegacyQuestionMigrationReviewManifest,
  serializeLegacyQuestionMigrationReviewPacket,
  validateLegacyQuestionMigrationReviewDecision,
  type LegacyQuestionMigrationReviewDecision,
  type LegacyQuestionMigrationReviewDetail,
} from "./legacyQuestionMigrationReviewPacket";

const observedAt = new Date("2026-09-22T08:00:00.000Z");
const revisionSha256 = "a".repeat(64);
const rawSha256 = "b".repeat(64);

function shadowRow(suffix = "1", overrides: Partial<LegacyQuestionMigrationShadowInput> = {}): LegacyQuestionMigrationShadowInput {
  const questionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const grantId = `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const criterionId = `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  return {
    questionId,
    grantId,
    criterionId,
    criterionStableKey: `criterion:other:${suffix}`,
    evaluationContractVersion: null,
    sourceRevisionSha256: null,
    sourceRawSha256: null,
    definitionSha256: "legacy-v0",
    answerType: "single",
    options: [
      { value: "yes", label: "해당", disqualifies: false },
      { value: "no", label: "비해당", disqualifies: true },
    ],
    reusable: "per_notice",
    conditionKey: null,
    provenance: { runId: `run-${suffix}` },
    criterion: {
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "시흥시 소재 기업" },
      confidence: 1,
      sourceSpan: "시흥시 소재 기업",
      needsReview: false,
    },
    currentSource: { sourceRevisionSha256: revisionSha256, sourceRawSha256: rawSha256 },
    legacyVisible: true,
    strictV2Visible: false,
    answerCount: 0,
    answeringCompanyCount: 0,
    ...overrides,
  };
}

function detail(row: LegacyQuestionMigrationShadowInput): LegacyQuestionMigrationReviewDetail {
  if (!row.criterionId || !row.criterion.dimension || !row.criterion.kind || !row.criterion.operator) {
    throw new Error("fixture criterion이 필요합니다.");
  }
  return {
    grant: {
      id: row.grantId,
      title: "시흥시 창업기업 지원",
      source: "bizinfo",
      sourceId: `source-${row.grantId}`,
      url: "https://example.invalid/grant",
      applyStart: "2026-09-01T00:00:00.000Z",
      applyEnd: "2026-09-30T00:00:00.000Z",
    },
    question: {
      id: row.questionId,
      grantId: row.grantId,
      criterionId: row.criterionId,
      evaluationContractVersion: row.evaluationContractVersion,
      sourceRevisionSha256: row.sourceRevisionSha256,
      sourceRawSha256: row.sourceRawSha256,
      criterionStableKey: row.criterionStableKey,
      definitionSha256: row.definitionSha256,
      version: 1,
      prompt: "귀사는 시흥시에 소재한 기업인가요?",
      options: row.options as Record<string, unknown>[],
      answerType: row.answerType,
      reusable: row.reusable,
      conditionKey: row.conditionKey,
      promptVersion: "legacy-v1",
      provenance: row.provenance,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    criterion: {
      id: row.criterionId,
      stableKey: row.criterionStableKey,
      dimension: row.criterion.dimension,
      kind: row.criterion.kind,
      operator: row.criterion.operator,
      value: row.criterion.value as Record<string, unknown>,
      confidence: row.criterion.confidence ?? 1,
      sourceSpan: row.criterion.sourceSpan ?? "",
      sourceField: "qualification",
      needsReview: row.criterion.needsReview ?? false,
      parserVersion: "deep-v1",
    },
  };
}

function bundleFor(rows: LegacyQuestionMigrationShadowInput[]) {
  return buildLegacyQuestionMigrationReviewBundle({
    shadowReport: buildLegacyQuestionMigrationShadowReport({ observedAt, rows }),
    details: rows.map(detail),
  });
}

test("사람 검수 후보만 exact source·criterion·legacy 질문에 결속된 packet이 된다", () => {
  const bundle = bundleFor([shadowRow()]);
  assert.equal(bundle.manifest.packetCount, 1);
  const packet = bundle.packets[0]!;
  assert.equal(packet.authority.status, "human_review_required");
  assert.equal(packet.authority.migrationAuthorized, false);
  assert.equal(packet.authority.liveQuestionWriteAuthorized, false);
  assert.equal(packet.currentSource.sourceRevisionSha256, revisionSha256);
  assert.equal(packet.criterion.sourceSpan, "시흥시 소재 기업");
  assert.equal(packet.legacyQuestion.prompt, "귀사는 시흥시에 소재한 기업인가요?");
  assert.equal(packet.requiredReview.expectedPolarity, "criterion_satisfaction");
  assert.equal(packet.requiredReview.decisionTemplate.verdict, null);
  assert.match(packet.contentSha256, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => serializeLegacyQuestionMigrationReviewPacket(packet));
  assert.doesNotThrow(() => serializeLegacyQuestionMigrationReviewManifest(bundle.manifest));
});

test("입력 순서와 무관한 manifest를 만들고 기존 답변은 보존 검수 수량으로 분리한다", () => {
  const first = shadowRow("1");
  const second = shadowRow("2", { answerCount: 2, answeringCompanyCount: 2 });
  const shadowReport = buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [second, first] });
  const left = buildLegacyQuestionMigrationReviewBundle({
    shadowReport,
    details: [detail(first), detail(second)],
  });
  const right = buildLegacyQuestionMigrationReviewBundle({
    shadowReport,
    details: [detail(second), detail(first)],
  });
  assert.equal(left.manifest.contentSha256, right.manifest.contentSha256);
  assert.equal(left.manifest.answerPreservationReviewCount, 1);
  assert.equal(left.packets[1]!.legacyQuestion.answerCount, 2);
});

test("shadow와 detail의 criterion·source 구조가 다르면 fail-closed한다", () => {
  const row = shadowRow();
  const wrong = detail(row);
  const shadowReport = buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [row] });
  assert.throws(() => buildLegacyQuestionMigrationReviewBundle({
    shadowReport,
    details: [{ ...wrong, criterion: { ...wrong.criterion, kind: "exclusion" } }],
  }), /결속이 다릅니다/);
  assert.throws(() => buildLegacyQuestionMigrationReviewBundle({
    shadowReport,
    details: [],
  }), /수량이 일치/);
});

test("회사 프로필 판정 질문은 이관 packet에서 제외한다", () => {
  const profileRow = shadowRow("3", {
    criterion: {
      ...shadowRow("3").criterion,
      dimension: "region",
      operator: "in",
      value: { regions: ["41"] },
      sourceSpan: "경기도 소재 기업",
    },
  });
  const report = buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [profileRow] });
  const bundle = buildLegacyQuestionMigrationReviewBundle({ shadowReport: report, details: [] });
  assert.equal(report.entries[0]?.disposition, "not_applicable");
  assert.equal(bundle.manifest.packetCount, 0);
});

test("승인 결정은 packet SHA·사람 검수자·구조 극성·공유 범위를 모두 요구한다", () => {
  const packet = bundleFor([shadowRow()]).packets[0]!;
  const decision: LegacyQuestionMigrationReviewDecision = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
    packetContentSha256: packet.contentSha256,
    candidateSha256: packet.candidateSha256,
    grantId: packet.grant.id,
    questionId: packet.legacyQuestion.id,
    criterionId: packet.criterion.id,
    verdict: "approve_for_v2_draft",
    confirmedPolarity: "criterion_satisfaction",
    resolutionScope: "company_fact",
    reviewerEmail: "reviewer@noten.im",
    reviewedAt: "2026-09-22T09:00:00.000Z",
    note: "시흥시 소재 여부는 같은 회사 사실로 재사용 가능",
  };
  const validated = validateLegacyQuestionMigrationReviewDecision({ packet, decision });
  assert.equal(validated.resolutionScope, "company_fact");
  assert.throws(() => validateLegacyQuestionMigrationReviewDecision({
    packet,
    decision: { ...decision, confirmedPolarity: "exclusion_membership" },
  }), /극성/);
  assert.throws(() => validateLegacyQuestionMigrationReviewDecision({
    packet,
    decision: { ...decision, packetContentSha256: "0".repeat(64) },
  }), /exact binding/);
});

test("수리·철회 결정은 승인된 극성이나 공유 범위를 가장하지 않는다", () => {
  const packet = bundleFor([shadowRow()]).packets[0]!;
  const base = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
    packetContentSha256: packet.contentSha256,
    candidateSha256: packet.candidateSha256,
    grantId: packet.grant.id,
    questionId: packet.legacyQuestion.id,
    criterionId: packet.criterion.id,
    verdict: "repair_criterion",
    confirmedPolarity: null,
    resolutionScope: null,
    reviewerEmail: "reviewer@noten.im",
    reviewedAt: "2026-09-22T09:00:00.000Z",
    note: null,
  } as const;
  assert.equal(validateLegacyQuestionMigrationReviewDecision({ packet, decision: base }).verdict, "repair_criterion");
  assert.throws(() => validateLegacyQuestionMigrationReviewDecision({
    packet,
    decision: { ...base, resolutionScope: "per_notice" },
  }), /기록하지 않습니다/);
});

test("packet 내용이 바뀌면 직렬화와 결정 검증이 거부된다", () => {
  const packet = bundleFor([shadowRow()]).packets[0]!;
  const tampered = JSON.parse(JSON.stringify(packet));
  tampered.legacyQuestion.prompt = "변조된 질문";
  assert.throws(() => serializeLegacyQuestionMigrationReviewPacket(tampered), /content SHA/);
  assert.throws(() => validateLegacyQuestionMigrationReviewDecision({ packet: tampered, decision: {} }), /content SHA/);
});

test("shadow 보고서 내용이 snapshot SHA와 다르면 packet 생성을 시작하지 않는다", () => {
  const row = shadowRow();
  const report = buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [row] });
  const tampered = JSON.parse(JSON.stringify(report));
  tampered.entries[0].definitionSha256 = "변조";
  assert.throws(() => buildLegacyQuestionMigrationReviewBundle({
    shadowReport: tampered,
    details: [detail(row)],
  }), /snapshot SHA/);
});

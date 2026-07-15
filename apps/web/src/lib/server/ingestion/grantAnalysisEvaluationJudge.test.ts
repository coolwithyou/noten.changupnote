import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import type {
  GrantAnalysisEvaluationAxisJudgment,
  GrantAnalysisEvaluationInputBlock,
  GrantAnalysisEvaluationJudgeId,
  GrantAnalysisEvaluationJudgeLedger,
  GrantAnalysisEvaluationJudgePacket,
  GrantAnalysisEvaluationState,
} from "@cunote/core";
import {
  auditGrantAnalysisEvaluationJudgeOutput,
  buildGrantAnalysisEvaluationJudge3Packet,
  buildGrantAnalysisEvaluationJudgePacket,
  finalizeGrantAnalysisEvaluationConsensus,
} from "./grantAnalysisEvaluationJudge";
import {
  FROZEN_GRANT_ANALYSIS_PILOT_COHORT,
  frozenGrantAnalysisPilotKey,
  type FrozenGrantAnalysisPilotEntry,
} from "./grantAnalysisPilotCohort";

// Minimal, network-free text shapes bound only to the frozen identity/revision
// of three legacy pilot entries. No sealed 40-grant identity is used here.
const frozen = {
  attachmentFailure: frozenEntry("kstartup_attachment_failure"),
  attachmentComplete: frozenEntry("unstructured_attachment_complete"),
  structuredControl: frozenEntry("structured_control"),
};
const fixtures = {
  sparseUnread: packet(frozen.attachmentFailure, [
    block("api", "paragraph", "p1", "지원대상은 공고문을 참조하세요."),
    block("attachment:notice", "page", "1", "", { expected: true, included: false, unreadReason: "conversion_failed" }),
  ]),
  attachmentLed: packet(frozen.attachmentComplete, [
    block("api", "paragraph", "p1", "세부 자격은 첨부파일 참조"),
    block("attachment:notice", "page", "3", "사업장 소재지가 서울특별시인 창업기업", { expected: true }),
  ]),
  structuredControl: packet(frozen.structuredControl, [
    block("api", "paragraph", "eligibility", "업력 7년 이내이며 인공지능 분야 중소기업"),
  ]),
};

assert.deepEqual(
  Object.values(fixtures).map((fixture) => [fixture.grantKey, fixture.sourceRevision]),
  Object.values(frozen).map((entry) => [frozenGrantAnalysisPilotKey(entry), entry.sourceRevision]),
);

for (const fixture of Object.values(fixtures)) {
  assert.equal(fixture.recordType, "grant_analysis_evaluation_raw_judge_packet");
  assert.deepEqual(Object.keys(fixture).sort(), [
    "blocks", "grantKey", "inputLimitsSha256", "inputOrder", "recordType", "schemaVersion", "sourceRevision",
  ]);
  const serialized = JSON.stringify(fixture);
  for (const forbidden of ["candidateLabel", "existingScore", "matchOutcome", "revealKey"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

const unreadAudit = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.sparseUnread,
  ledger: ledger("judge_1", fixtures.sparseUnread, {
    region: judgment("region", "explicit_no_condition"),
  }),
});
assert.equal(unreadAudit.ledger.axes.find((axis) => axis.dimension === "region")?.state, "unknown");
assert.equal(unreadAudit.issues.some((issue) => issue.code === "expected_input_unread"), true);

const rawUnreadPacket = packet(frozen.attachmentFailure, [
  block("api", "paragraph", "p1", "", {
    expected: true,
    included: false,
    unreadReason: "raw_payload_missing",
  }),
]);
const rawUnreadAudit = auditGrantAnalysisEvaluationJudgeOutput({
  packet: rawUnreadPacket,
  ledger: ledger("judge_1", rawUnreadPacket, {
    region: judgment("region", "explicit_no_condition"),
  }),
});
assert.equal(rawUnreadAudit.ledger.axes.find((axis) => axis.dimension === "region")?.state, "unknown");
assert.equal(rawUnreadAudit.issues.some((issue) => issue.code === "expected_input_unread"), true);

const wrongLocationAudit = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.attachmentLed,
  ledger: ledger("judge_1", fixtures.attachmentLed, {
    region: judgment("region", "condition_present", { regions: ["11"] }, {
      artifactId: "attachment:notice",
      locatorKind: "page",
      locator: "2",
      quote: "사업장 소재지가 서울특별시",
    }),
  }),
});
assert.equal(wrongLocationAudit.ledger.axes.find((axis) => axis.dimension === "region")?.state, "unknown");
assert.equal(wrongLocationAudit.issues.some((issue) => issue.code === "quote_not_in_claimed_block"), true);

const ungroundedNoCondition = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.attachmentLed,
  ledger: ledger("judge_1", fixtures.attachmentLed, {
    region: judgment("region", "explicit_no_condition", null, {
      artifactId: "attachment:notice",
      locatorKind: "page",
      locator: "2",
      quote: "지역 제한 없음",
    }),
  }),
});
assert.equal(ungroundedNoCondition.ledger.axes.find((axis) => axis.dimension === "region")?.state, "unknown");
assert.equal(ungroundedNoCondition.issues.some((issue) => issue.code === "quote_not_in_claimed_block"), true);

const grounded = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.attachmentLed,
  ledger: ledger("judge_1", fixtures.attachmentLed, {
    region: judgment("region", "condition_present", { regions: ["11"] }, {
      artifactId: "attachment:notice",
      locatorKind: "page",
      locator: "3",
      quote: "사업장 소재지가 서울특별시",
    }),
  }),
});
assert.equal(grounded.ledger.axes.find((axis) => axis.dimension === "region")?.state, "condition_present");
assert.equal(grounded.issues.length, 0);

const recovered = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.structuredControl,
  ledger: {
    ...ledger("judge_1", fixtures.structuredControl, {
      biz_age: judgment("biz_age", "condition_present", { max_months: 84 }, {
        artifactId: "api", locatorKind: "paragraph", locator: "eligibility", quote: "업력 7년 이내",
      }),
    }),
    schemaRecovered: true,
  },
});
assert.equal(recovered.ledger.axes.find((axis) => axis.dimension === "biz_age")?.state, "unknown");
assert.equal(recovered.issues.some((issue) => issue.code === "schema_recovered"), true);

assert.throws(
  () => auditGrantAnalysisEvaluationJudgeOutput({
    packet: fixtures.structuredControl,
    ledger: partialJudge3(fixtures.structuredControl, [
      judgment("industry", "invalid_state" as GrantAnalysisEvaluationState),
    ]),
  }),
  /Invalid Judge 3 state for industry/,
);
assert.throws(
  () => auditGrantAnalysisEvaluationJudgeOutput({
    packet: fixtures.structuredControl,
    ledger: partialJudge3(fixtures.structuredControl, [judgment("industry", "condition_present")]),
  }),
  /condition_present requires normalizedCondition/,
);
assert.throws(
  () => auditGrantAnalysisEvaluationJudgeOutput({
    packet: fixtures.structuredControl,
    ledger: partialJudge3(fixtures.structuredControl, [
      judgment("industry", "explicit_no_condition", { tags: ["AI"] }),
    ]),
  }),
  /explicit_no_condition cannot carry normalizedCondition/,
);

const judge1 = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.structuredControl,
  ledger: ledger("judge_1", fixtures.structuredControl, {
    industry: judgment("industry", "unknown"),
  }),
});
const judge2 = auditGrantAnalysisEvaluationJudgeOutput({
  packet: fixtures.structuredControl,
  ledger: ledger("judge_2", fixtures.structuredControl, {
    industry: judgment("industry", "condition_present", { tags: ["AI"] }, {
      artifactId: "api", locatorKind: "paragraph", locator: "eligibility", quote: "인공지능 분야",
    }),
  }),
});
const judge3Packet = buildGrantAnalysisEvaluationJudge3Packet({
  raw: fixtures.structuredControl,
  judge1: judge1.ledger,
  judge2: judge2.ledger,
});
assert.deepEqual(judge3Packet.disagreements.map((entry) => entry.dimension), ["industry"]);
assert.equal(JSON.stringify(judge3Packet).includes("matchOutcome"), false);

const final = finalizeGrantAnalysisEvaluationConsensus({ judge1, judge2 });
assert.equal(final.axes.find((axis) => axis.dimension === "industry")?.state, "unresolved");
assert.deepEqual(final.judge3EligibleAxes, ["industry"]);

console.log("grantAnalysisEvaluationJudge.test.ts: all assertions passed");

function frozenEntry(stratum: string): FrozenGrantAnalysisPilotEntry {
  const entry = FROZEN_GRANT_ANALYSIS_PILOT_COHORT.find((candidate) => candidate.stratum === stratum);
  assert.ok(entry, `missing frozen pilot fixture for ${stratum}`);
  return entry;
}

function packet(entry: FrozenGrantAnalysisPilotEntry, blocks: GrantAnalysisEvaluationInputBlock[]) {
  return buildGrantAnalysisEvaluationJudgePacket({
    grantKey: frozenGrantAnalysisPilotKey(entry),
    sourceRevision: entry.sourceRevision,
    blocks,
    inputLimits: { maxApiCharacters: 14_000, maxAttachmentCharacters: 18_000 },
  });
}

function block(
  artifactId: string,
  locatorKind: "page" | "paragraph",
  locator: string,
  text: string,
  options: Partial<GrantAnalysisEvaluationInputBlock> = {},
): GrantAnalysisEvaluationInputBlock {
  return {
    artifactId,
    kind: artifactId === "api" ? "raw_api" : "attachment_markdown",
    locatorKind,
    locator,
    text,
    expected: options.expected ?? true,
    included: options.included ?? true,
    ...options,
  };
}

function ledger(
  judgeId: GrantAnalysisEvaluationJudgeId,
  packet: GrantAnalysisEvaluationJudgePacket,
  overrides: Partial<Record<CriterionDimension, GrantAnalysisEvaluationAxisJudgment>> = {},
): GrantAnalysisEvaluationJudgeLedger {
  return {
    recordType: "grant_analysis_evaluation_judge_ledger",
    schemaVersion: 1,
    judgeId,
    grantKey: packet.grantKey,
    sourceRevision: packet.sourceRevision,
    truncated: false,
    schemaRecovered: false,
    axes: CRITERION_DIMENSIONS.map((dimension) =>
      overrides[dimension] ?? judgment(dimension, "unknown")),
  };
}

function partialJudge3(
  packet: GrantAnalysisEvaluationJudgePacket,
  axes: GrantAnalysisEvaluationAxisJudgment[],
): GrantAnalysisEvaluationJudgeLedger {
  return {
    recordType: "grant_analysis_evaluation_judge_ledger",
    schemaVersion: 1,
    judgeId: "judge_3",
    grantKey: packet.grantKey,
    sourceRevision: packet.sourceRevision,
    truncated: false,
    schemaRecovered: false,
    axes,
  };
}

function judgment(
  dimension: CriterionDimension,
  state: GrantAnalysisEvaluationState,
  normalizedCondition: unknown | null = null,
  evidence?: GrantAnalysisEvaluationAxisJudgment["evidence"][number],
): GrantAnalysisEvaluationAxisJudgment {
  return {
    dimension,
    state,
    normalizedCondition,
    evidence: evidence ? [evidence] : [],
    confidence: 0.9,
    exceptions: [],
    logicalRelation: state === "condition_present" ? "and" : "not_applicable",
    applicablePeriod: null,
    note: "",
  };
}

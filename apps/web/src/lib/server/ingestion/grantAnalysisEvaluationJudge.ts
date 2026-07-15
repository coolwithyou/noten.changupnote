import { createHash } from "node:crypto";
import type { CriterionDimension } from "@cunote/contracts";
import {
  GRANT_ANALYSIS_EVALUATION_AXES,
  GRANT_ANALYSIS_EVALUATION_STATES,
  buildGrantAnalysisEvaluationConsensus,
  validateGrantAnalysisEvaluationJudgeLedger,
  type GrantAnalysisEvaluationAxisJudgment,
  type GrantAnalysisEvaluationConsensus,
  type GrantAnalysisEvaluationInputBlock,
  type GrantAnalysisEvaluationJudgeLedger,
  type GrantAnalysisEvaluationJudgePacket,
} from "@cunote/core";

export const GRANT_ANALYSIS_EVALUATION_JUDGE_PROMPT_VERSION =
  "grant-analysis-evaluation-raw-only-judge-v1";
export const GRANT_ANALYSIS_EVALUATION_JUDGE_SCHEMA_VERSION =
  "grant-analysis-evaluation-judge-schema-v1";

export interface GrantAnalysisEvaluationJudgeAuditIssue {
  dimension: CriterionDimension;
  code:
    | "quote_not_in_claimed_block"
    | "expected_input_unread"
    | "truncated_input"
    | "truncated_output"
    | "schema_recovered";
  detail: string;
}

export interface GrantAnalysisEvaluationAuditedLedger {
  ledger: GrantAnalysisEvaluationJudgeLedger;
  issues: readonly GrantAnalysisEvaluationJudgeAuditIssue[];
}

export interface GrantAnalysisEvaluationJudge3Packet {
  recordType: "grant_analysis_evaluation_raw_judge_3_packet";
  schemaVersion: 1;
  grantKey: string;
  sourceRevision: string;
  raw: GrantAnalysisEvaluationJudgePacket;
  disagreements: readonly {
    dimension: CriterionDimension;
    judge1: GrantAnalysisEvaluationAxisJudgment;
    judge2: GrantAnalysisEvaluationAxisJudgment;
  }[];
}

/**
 * Copies only raw API and marked attachment blocks into the Judge packet.
 * Candidate labels, scores, match outcomes, and reveal material have no input
 * field in this boundary and are discarded even when callers carry them.
 */
export function buildGrantAnalysisEvaluationJudgePacket(options: {
  grantKey: string;
  sourceRevision: string;
  blocks: readonly GrantAnalysisEvaluationInputBlock[];
  inputLimits: unknown;
}): GrantAnalysisEvaluationJudgePacket {
  assertNonEmpty(options.grantKey, "grantKey");
  assertNonEmpty(options.sourceRevision, "sourceRevision");
  const seen = new Set<string>();
  const blocks = options.blocks.map((block) => {
    if (block.kind !== "raw_api" && block.kind !== "attachment_markdown") {
      throw new Error(`Unsupported Judge input block kind: ${String(block.kind)}.`);
    }
    assertNonEmpty(block.artifactId, "artifactId");
    assertNonEmpty(block.locator, "locator");
    const key = blockKey(block);
    if (seen.has(key)) throw new Error(`Duplicate Judge input block: ${key}.`);
    seen.add(key);
    if (block.included && block.unreadReason) {
      throw new Error(`${key}: an included block cannot have unreadReason.`);
    }
    return {
      artifactId: block.artifactId.trim(),
      kind: block.kind,
      locatorKind: block.locatorKind,
      locator: block.locator.trim(),
      text: block.included ? block.text : "",
      expected: block.expected,
      included: block.included,
      ...(block.unreadReason?.trim() ? { unreadReason: block.unreadReason.trim() } : {}),
      ...(block.truncated ? { truncated: true } : {}),
    } satisfies GrantAnalysisEvaluationInputBlock;
  });
  return {
    recordType: "grant_analysis_evaluation_raw_judge_packet",
    schemaVersion: 1,
    grantKey: options.grantKey.trim(),
    sourceRevision: options.sourceRevision.trim(),
    blocks,
    inputOrder: blocks.map(blockKey),
    inputLimitsSha256: sha256(stableStringify(options.inputLimits)),
  };
}

/** Applies deterministic grounding and incomplete-input fail-closed rules. */
export function auditGrantAnalysisEvaluationJudgeOutput(options: {
  packet: GrantAnalysisEvaluationJudgePacket;
  ledger: GrantAnalysisEvaluationJudgeLedger;
}): GrantAnalysisEvaluationAuditedLedger {
  const ledger = options.ledger.judgeId === "judge_3"
    ? validatePartialJudge3Ledger(options.ledger)
    : validateGrantAnalysisEvaluationJudgeLedger(options.ledger);
  if (ledger.grantKey !== options.packet.grantKey ||
      ledger.sourceRevision !== options.packet.sourceRevision) {
    throw new Error("Judge output identity/revision does not match its raw packet.");
  }
  const expectedInputUnread = options.packet.blocks.some((block) =>
    block.expected && (!block.included || Boolean(block.unreadReason)));
  const truncatedInput = options.packet.blocks.some((block) => block.truncated);
  const issues: GrantAnalysisEvaluationJudgeAuditIssue[] = [];
  const axes = ledger.axes.map((axis) => {
    const axisIssues: GrantAnalysisEvaluationJudgeAuditIssue[] = [];
    const grounded = axis.evidence.every((evidence) =>
      evidence.quote.trim().length > 0 && options.packet.blocks.some((block) =>
        block.included &&
        block.artifactId === evidence.artifactId &&
        block.locatorKind === evidence.locatorKind &&
        block.locator === evidence.locator &&
        normalizeText(block.text).includes(normalizeText(evidence.quote))));
    if ((axis.evidence.length > 0 && !grounded) ||
        (axis.state === "condition_present" && axis.evidence.length === 0)) {
      axisIssues.push({
        dimension: axis.dimension,
        code: "quote_not_in_claimed_block",
        detail: "Evidence was missing or a supplied quote was not found in its claimed included artifact and locator block.",
      });
    }
    if (axis.state === "explicit_no_condition" && expectedInputUnread) {
      axisIssues.push({
        dimension: axis.dimension,
        code: "expected_input_unread",
        detail: "At least one expected input block was missing or unread.",
      });
    }
    if (truncatedInput && isConfirmedState(axis.state)) {
      axisIssues.push({
        dimension: axis.dimension,
        code: "truncated_input",
        detail: "At least one marked input block was truncated.",
      });
    }
    if (ledger.truncated && isConfirmedState(axis.state)) {
      axisIssues.push({
        dimension: axis.dimension,
        code: "truncated_output",
        detail: "The Judge output reached its truncation boundary.",
      });
    }
    if (ledger.schemaRecovered && isConfirmedState(axis.state)) {
      axisIssues.push({
        dimension: axis.dimension,
        code: "schema_recovered",
        detail: "The Judge output required schema recovery.",
      });
    }
    issues.push(...axisIssues);
    if (axisIssues.length === 0) return axis;
    return {
      ...axis,
      state: "unknown" as const,
      normalizedCondition: null,
      confidence: 0,
      note: [axis.note, ...axisIssues.map((issue) => issue.code)].filter(Boolean).join("; "),
    };
  });
  return { ledger: { ...ledger, axes }, issues };
}

export function buildGrantAnalysisEvaluationJudge3Packet(options: {
  raw: GrantAnalysisEvaluationJudgePacket;
  judge1: GrantAnalysisEvaluationJudgeLedger;
  judge2: GrantAnalysisEvaluationJudgeLedger;
}): GrantAnalysisEvaluationJudge3Packet {
  const pending = buildGrantAnalysisEvaluationConsensus({
    judge1: options.judge1,
    judge2: options.judge2,
  });
  if (pending.grantKey !== options.raw.grantKey ||
      pending.sourceRevision !== options.raw.sourceRevision) {
    throw new Error("Judge agreement does not match the raw packet identity/revision.");
  }
  const judge1 = new Map(options.judge1.axes.map((axis) => [axis.dimension, axis]));
  const judge2 = new Map(options.judge2.axes.map((axis) => [axis.dimension, axis]));
  return {
    recordType: "grant_analysis_evaluation_raw_judge_3_packet",
    schemaVersion: 1,
    grantKey: options.raw.grantKey,
    sourceRevision: options.raw.sourceRevision,
    raw: options.raw,
    disagreements: pending.disagreementAxes.map((dimension) => ({
      dimension,
      judge1: judge1.get(dimension)!,
      judge2: judge2.get(dimension)!,
    })),
  };
}

export function finalizeGrantAnalysisEvaluationConsensus(options: {
  judge1: GrantAnalysisEvaluationAuditedLedger;
  judge2: GrantAnalysisEvaluationAuditedLedger;
  judge3?: GrantAnalysisEvaluationAuditedLedger | null;
}): GrantAnalysisEvaluationConsensus {
  return buildGrantAnalysisEvaluationConsensus({
    judge1: options.judge1.ledger,
    judge2: options.judge2.ledger,
    ...(options.judge3 ? { judge3: options.judge3.ledger } : {}),
  });
}

export function buildGrantAnalysisEvaluationJudgeSchema(options: {
  judgeId: "judge_1" | "judge_2" | "judge_3";
  eligibleAxes?: readonly CriterionDimension[];
}) {
  const axes = options.judgeId === "judge_3"
    ? [...(options.eligibleAxes ?? [])]
    : [...GRANT_ANALYSIS_EVALUATION_AXES];
  return {
    schemaVersion: GRANT_ANALYSIS_EVALUATION_JUDGE_SCHEMA_VERSION,
    judgeId: options.judgeId,
    axes,
    states: ["condition_present", "explicit_no_condition", "unknown", "unresolved"] as const,
    requiredFields: [
      "dimension", "state", "normalizedCondition", "evidence", "confidence",
      "exceptions", "logicalRelation", "applicablePeriod", "note",
    ] as const,
  };
}

function blockKey(block: Pick<GrantAnalysisEvaluationInputBlock,
  "artifactId" | "locatorKind" | "locator">): string {
  return `${block.artifactId.trim()}#${block.locatorKind}:${block.locator.trim()}`;
}

function validatePartialJudge3Ledger(
  ledger: GrantAnalysisEvaluationJudgeLedger,
): GrantAnalysisEvaluationJudgeLedger {
  const seen = new Set<CriterionDimension>();
  for (const axis of ledger.axes) {
    if (!GRANT_ANALYSIS_EVALUATION_AXES.includes(axis.dimension)) {
      throw new Error(`Unknown Judge 3 axis: ${String(axis.dimension)}.`);
    }
    if (seen.has(axis.dimension)) throw new Error(`Duplicate Judge 3 axis: ${axis.dimension}.`);
    seen.add(axis.dimension);
    if (!GRANT_ANALYSIS_EVALUATION_STATES.includes(axis.state)) {
      throw new Error(`Invalid Judge 3 state for ${axis.dimension}: ${String(axis.state)}.`);
    }
    if (!Number.isFinite(axis.confidence) || axis.confidence < 0 || axis.confidence > 1) {
      throw new Error(`${axis.dimension}: confidence must be between 0 and 1.`);
    }
    if (axis.state === "condition_present" && axis.normalizedCondition === null) {
      throw new Error(`${axis.dimension}: condition_present requires normalizedCondition.`);
    }
    if (axis.state === "explicit_no_condition" && axis.normalizedCondition !== null) {
      throw new Error(`${axis.dimension}: explicit_no_condition cannot carry normalizedCondition.`);
    }
  }
  return ledger;
}

function isConfirmedState(state: GrantAnalysisEvaluationAxisJudgment["state"]): boolean {
  return state === "condition_present" || state === "explicit_no_condition";
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
}

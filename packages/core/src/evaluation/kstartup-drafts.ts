import type { GrantCriterion, GrantRequiredDocument, NormalizedGrant } from "@cunote/contracts";
import { assertGrantCriteriaContract } from "../bizinfo/criteria-contract.js";
import { KSTARTUP_LLM_EXTRACTOR_VERSION } from "../kstartup/llm-criteria.js";
import { buildMatchingV3GrantReviewTask, type MatchingV3GrantReviewTask } from "./review-packet.js";

export interface KStartupCriteriaDraft {
  recordType: "kstartup_criteria_draft";
  source: "kstartup";
  sourceId: string;
  title: string;
  extractorVersion: string;
  model: string;
  inputSha256: string;
  criteria: GrantCriterion[];
  requiredDocuments: GrantRequiredDocument[];
  reviewStatus: "draft";
  operationalReady: false;
}

export interface KStartupCriteriaDraftError {
  recordType: "kstartup_criteria_draft_error";
  source: "kstartup";
  sourceId: string;
  title: string;
  extractorVersion: string;
  error: string;
  operationalReady: false;
}

export interface KStartupCriteriaDraftDataset {
  drafts: KStartupCriteriaDraft[];
  errors: KStartupCriteriaDraftError[];
}

export interface BizInfoCriteriaDraft {
  recordType: "bizinfo_criteria_draft";
  source: "bizinfo";
  sourceId: string;
  title: string;
  extractorVersion: string;
  model: string;
  inputSha256: string;
  criteria: GrantCriterion[];
  requiredDocuments: GrantRequiredDocument[];
  reviewStatus: "draft";
  operationalReady: false;
}

export interface BizInfoCriteriaDraftError {
  recordType: "bizinfo_criteria_draft_error";
  source: "bizinfo";
  sourceId: string;
  title: string;
  extractorVersion: string;
  error: string;
  operationalReady: false;
}

export interface BizInfoCriteriaDraftDataset {
  drafts: BizInfoCriteriaDraft[];
  errors: BizInfoCriteriaDraftError[];
}

type CriteriaDraft = KStartupCriteriaDraft | BizInfoCriteriaDraft;
type CriteriaDraftError = KStartupCriteriaDraftError | BizInfoCriteriaDraftError;
type DraftSource = CriteriaDraft["source"];

export function parseKStartupCriteriaDraftJsonl(
  text: string,
  sourceName = "kstartup-llm-drafts.jsonl",
): KStartupCriteriaDraftDataset {
  const dataset = parseCriteriaDraftJsonl(text, "kstartup", sourceName);
  return {
    drafts: dataset.drafts as KStartupCriteriaDraft[],
    errors: dataset.errors as KStartupCriteriaDraftError[],
  };
}

export function parseBizInfoCriteriaDraftJsonl(
  text: string,
  sourceName = "bizinfo-llm-drafts.jsonl",
): BizInfoCriteriaDraftDataset {
  const dataset = parseCriteriaDraftJsonl(text, "bizinfo", sourceName);
  return {
    drafts: dataset.drafts as BizInfoCriteriaDraft[],
    errors: dataset.errors as BizInfoCriteriaDraftError[],
  };
}

function parseCriteriaDraftJsonl(
  text: string,
  source: DraftSource,
  sourceName: string,
): { drafts: CriteriaDraft[]; errors: CriteriaDraftError[] } {
  const records = text.split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), location: `${sourceName}:${index + 1}` }))
    .filter((entry) => entry.line.length > 0 && !entry.line.startsWith("#"))
    .map((entry) => parseDraftRecord(entry.line, entry.location, source));
  const drafts = records.filter((record): record is CriteriaDraft => !record.recordType.endsWith("_error"));
  const errors = records.filter((record): record is CriteriaDraftError => record.recordType.endsWith("_error"));
  assertUniqueSourceIds(records, sourceName);
  return { drafts, errors };
}

export function buildKStartupDraftReviewTask<TPayload>(
  entry: NormalizedGrant<TPayload>,
  draft: KStartupCriteriaDraft,
): MatchingV3GrantReviewTask {
  return buildCriteriaDraftReviewTask(entry, draft);
}

export function buildBizInfoDraftReviewTask<TPayload>(
  entry: NormalizedGrant<TPayload>,
  draft: BizInfoCriteriaDraft,
): MatchingV3GrantReviewTask {
  return buildCriteriaDraftReviewTask(entry, draft);
}

function buildCriteriaDraftReviewTask<TPayload>(
  entry: NormalizedGrant<TPayload>,
  draft: CriteriaDraft,
): MatchingV3GrantReviewTask {
  if (entry.grant.source !== draft.source || entry.grant.source_id !== draft.sourceId) {
    throw new Error(`draft/current grant mismatch: ${draft.source}:${draft.sourceId}`);
  }
  if (entry.grant.title !== draft.title) throw new Error(`draft title mismatch: ${draft.source}:${draft.sourceId}`);
  return buildMatchingV3GrantReviewTask(entry, {
    sourceFixture: `draft:${draft.source}:${draft.sourceId}:${draft.inputSha256}`,
    predictedCriteria: draft.criteria,
    predictionProvenance: {
      extractorVersion: draft.extractorVersion,
      model: draft.model,
      inputSha256: draft.inputSha256,
    },
    predictedRequiredDocuments: draft.requiredDocuments,
  });
}

function parseDraftRecord(line: string, location: string, source: DraftSource): CriteriaDraft | CriteriaDraftError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`${location}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = requireRecord(parsed, location);
  if (record.source !== source) throw new Error(`${location}: source must be ${source}`);
  if (record.operationalReady !== false) throw new Error(`${location}: operationalReady must be false`);
  const base = {
    source,
    sourceId: requireString(record.sourceId, `${location}.sourceId`),
    title: requireString(record.title, `${location}.title`),
    extractorVersion: requireString(record.extractorVersion, `${location}.extractorVersion`),
    operationalReady: false as const,
  };
  const draftRecordType = `${source}_criteria_draft` as CriteriaDraft["recordType"];
  const errorRecordType = `${source}_criteria_draft_error` as CriteriaDraftError["recordType"];
  if (record.recordType === errorRecordType) {
    return { ...base, recordType: errorRecordType, error: requireString(record.error, `${location}.error`) } as CriteriaDraftError;
  }
  if (record.recordType !== draftRecordType) throw new Error(`${location}: invalid recordType`);
  if (record.reviewStatus !== "draft") throw new Error(`${location}: reviewStatus must be draft`);
  if (typeof record.inputSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.inputSha256)) {
    throw new Error(`${location}.inputSha256 must be a sha256 hex string`);
  }
  if (!Array.isArray(record.criteria)) throw new Error(`${location}.criteria must be an array`);
  const criteria = record.criteria as GrantCriterion[];
  assertGrantCriteriaContract(criteria, `${location}.criteria`);
  for (const criterion of criteria) {
    if (criterion.grant_id !== base.sourceId) {
      throw new Error(`${location}: criterion grant_id must match sourceId (${criterion.id ?? criterion.dimension})`);
    }
    if (
      (criterion.parser_version === KSTARTUP_LLM_EXTRACTOR_VERSION || criterion.id?.includes(":llm-")) &&
      criterion.needs_review !== true
    ) {
      throw new Error(`${location}: LLM criterion must have needs_review=true (${criterion.id ?? criterion.dimension})`);
    }
  }
  if (!Array.isArray(record.requiredDocuments)) throw new Error(`${location}.requiredDocuments must be an array`);
  const requiredDocuments = record.requiredDocuments.map((document, index) =>
    parseRequiredDocument(document, `${location}.requiredDocuments[${index}]`));
  return {
    ...base,
    recordType: draftRecordType,
    model: requireString(record.model, `${location}.model`),
    inputSha256: record.inputSha256,
    criteria,
    requiredDocuments,
    reviewStatus: "draft",
  } as CriteriaDraft;
}

function parseRequiredDocument(value: unknown, location: string): GrantRequiredDocument {
  const record = requireRecord(value, location);
  if (typeof record.required !== "boolean") throw new Error(`${location}.required must be boolean`);
  if (record.source !== "self" && record.source !== "portal" && record.source !== "cert") {
    throw new Error(`${location}.source must be self|portal|cert`);
  }
  const sourceSpan = requireString(record.source_span, `${location}.source_span`);
  const document: GrantRequiredDocument = {
    name: requireString(record.name, `${location}.name`),
    required: record.required,
    source: record.source,
    source_span: sourceSpan,
  };
  if (typeof record.note === "string" && record.note.trim()) document.note = record.note.trim();
  return document;
}

function assertUniqueSourceIds(
  records: Array<CriteriaDraft | CriteriaDraftError>,
  sourceName: string,
): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.sourceId)) throw new Error(`${sourceName}: duplicate sourceId ${record.sourceId}`);
    seen.add(record.sourceId);
  }
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  return value;
}

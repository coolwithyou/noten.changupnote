import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CompanyProfile, MatchResult, NormalizedGrant } from "@cunote/contracts";
import {
  compareGrantAnalysisPilotVariants,
  resolveGrantExtractionManifest,
  type BizInfoProgram,
  type GrantAnalysisPilotComparison,
  type GrantAnalysisPilotVariant,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import {
  FROZEN_GRANT_ANALYSIS_PILOT_COHORT,
  GRANT_ANALYSIS_PILOT_AS_OF,
  GRANT_ANALYSIS_PILOT_OBSERVED_AT,
  frozenGrantAnalysisPilotKey,
  type FrozenGrantAnalysisPilotEntry,
} from "../ingestion/grantAnalysisPilotCohort";
import {
  GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
  extractGrantAnalysisPilotWithAnthropic,
  type GrantAnalysisPilotExtractionResult,
} from "../ingestion/grantAnalysisPilotExtractor";
import {
  buildGrantAnalysisPilotInputs,
  type GrantAnalysisPilotInputs,
  type GrantAnalysisPilotInputVariant,
} from "../ingestion/grantAnalysisPilotInputs";
import {
  buildGrantAnalysisPilotVariant,
  buildGrantAnalysisShadowMatch,
} from "../ingestion/grantAnalysisPilotVariants";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";

loadMonorepoEnv();
// serviceData는 import 시점에 repository mode를 고르므로 env 로드 뒤에 평가해야 한다.
const { resolveAnonymousProductCompanyProfile } = await import("../serviceData");

const PILOT_RUN_VERSION = "grant-analysis-abc-2026-07-15-v1";
const extract = process.argv.includes("--extract");
const confirmation = readArg("confirm");
const asOf = new Date(readArg("asOf") ?? GRANT_ANALYSIS_PILOT_AS_OF);
const profileAsOf = new Date(readArg("profileAsOf") ?? GRANT_ANALYSIS_PILOT_OBSERVED_AT);
const bizNo = readArg("bizNo") ?? process.env.GRANT_ANALYSIS_PILOT_BIZ_NO?.trim();
const outputDir = resolve(readArg("outputDir") ?? "tmp/grant-analysis-pilot/2026-07-15");
const requestedKeys = new Set(csvArg(readArg("grantKeys")));
const resume = !process.argv.includes("--no-resume");
const retryFailures = process.argv.includes("--retry-failures");
const reprocessCheckpoints = process.argv.includes("--reprocess-checkpoints");
const priorConfirmedFailedCalls = nonNegativeIntegerArg("priorConfirmedFailedCalls", 0);
const priorInterruptedCalls = nonNegativeIntegerArg("priorInterruptedCalls", 0);
if (Number.isNaN(asOf.getTime())) throw new Error("--asOf must be a valid timestamp");
if (Number.isNaN(profileAsOf.getTime())) throw new Error("--profileAsOf must be a valid timestamp");
if (!bizNo) throw new Error("--bizNo or GRANT_ANALYSIS_PILOT_BIZ_NO is required");
if (extract && confirmation !== "RUN_GRANT_ANALYSIS_PILOT") {
  throw new Error("--extract requires --confirm=RUN_GRANT_ANALYSIS_PILOT");
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (extract && !apiKey) throw new Error("ANTHROPIC_API_KEY is required for --extract");

const frozenCohort = FROZEN_GRANT_ANALYSIS_PILOT_COHORT.filter((entry) =>
  requestedKeys.size === 0 || requestedKeys.has(frozenGrantAnalysisPilotKey(entry)));
if (frozenCohort.length === 0) throw new Error("No frozen cohort grants selected.");
const unknownRequested = [...requestedKeys].filter((key) =>
  !FROZEN_GRANT_ANALYSIS_PILOT_COHORT.some((entry) => frozenGrantAnalysisPilotKey(entry) === key));
if (unknownRequested.length > 0) throw new Error(`Unknown frozen grant keys: ${unknownRequested.join(", ")}`);

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const universe = await repositories.grants.listActiveGrants({ asOf, limit: 2_000 });
  const selected = freezeAndSelect(universe, frozenCohort);
  const storage = createR2ObjectStorageFromEnv();
  const inputBundles: Array<{ cohort: FrozenGrantAnalysisPilotEntry; entry: NormalizedGrant<unknown>; inputs: GrantAnalysisPilotInputs }> = [];
  for (const { cohort, entry } of selected) {
    const inputs = await buildGrantAnalysisPilotInputs({ entry, storage });
    inputBundles.push({ cohort, entry, inputs });
  }

  const inputPlan = inputBundles.map(({ cohort, inputs }) => ({
    grantKey: frozenGrantAnalysisPilotKey(cohort),
    title: cohort.title,
    sourceRevision: inputs.sourceRevision,
    apiCharacters: inputs.apiOnly.characterCount,
    attachmentExpected: inputs.attachments.counts.expected,
    attachmentFetched: inputs.attachments.counts.fetched,
    attachmentConverted: inputs.attachments.counts.converted,
    attachmentLoaded: inputs.attachments.counts.loaded,
    attachmentIncluded: inputs.attachments.counts.included,
    attachmentCharactersIncluded: inputs.attachments.characters.includedAttachmentMarkdown,
    warnings: inputs.warnings,
  }));

  if (!extract) {
    console.log(JSON.stringify({
      mode: "plan",
      pilotRunVersion: PILOT_RUN_VERSION,
      asOf: asOf.toISOString(),
      profileAsOf: profileAsOf.toISOString(),
      bizNo,
      databaseWriteMode: false,
      externalLlmCalls: 0,
      activeCanonicalUniverse: universe.length,
      frozenGrantCount: frozenCohort.length,
      storageConfigured: Boolean(storage),
      plannedMinimumLlmCalls: frozenCohort.length,
      plannedMaximumLlmCalls: frozenCohort.length * 2,
      grants: inputPlan,
      nextStep: "Re-run with --extract --confirm=RUN_GRANT_ANALYSIS_PILOT after reviewing this exact plan.",
    }, null, 2));
  } else {
    mkdirSync(join(outputDir, "checkpoints"), { recursive: true });
    const profileResolution = await resolveAnonymousProductCompanyProfile({ bizNo }, { asOf: profileAsOf });
    const profileHash = sha256(stableStringify(profileResolution.profile));
    const records: PilotGrantRecord[] = [];
    const failures: PilotGrantFailure[] = [];

    for (const [index, bundle] of inputBundles.entries()) {
      const key = frozenGrantAnalysisPilotKey(bundle.cohort);
      const checkpointPath = join(outputDir, "checkpoints", `${safeFilename(key)}.json`);
      if (resume && existsSync(checkpointPath)) {
        const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as PilotGrantRecord | PilotGrantFailure;
        assertCheckpoint(checkpoint, bundle.cohort);
        if (checkpoint.recordType === "grant_analysis_pilot_result") {
          if (reprocessCheckpoints) {
            const reprocessed = reprocessPilotRecord({
              checkpoint,
              entry: bundle.entry,
              inputs: bundle.inputs,
              company: profileResolution.profile,
              profileHash,
            });
            writeJsonAtomic(checkpointPath, reprocessed);
            records.push(reprocessed);
            console.log(`[${index + 1}/${inputBundles.length}] ${key}: reprocessed checkpoint without LLM call`);
          } else {
            records.push(checkpoint);
            console.log(`[${index + 1}/${inputBundles.length}] ${key}: resumed checkpoint`);
          }
          continue;
        }
        if (!retryFailures) {
          failures.push(checkpoint);
          console.log(`[${index + 1}/${inputBundles.length}] ${key}: resumed failure checkpoint`);
          continue;
        }
        console.log(`[${index + 1}/${inputBundles.length}] ${key}: retrying prior failure`);
      }
      console.log(`[${index + 1}/${inputBundles.length}] ${key}: extracting B`);
      try {
        const B = await extractVariant(bundle.entry, bundle.inputs.apiOnly, apiKey!);
        const cReusedB = bundle.inputs.apiOnly.inputSha256 === bundle.inputs.apiPlusAttachments.inputSha256;
        let C: GrantAnalysisPilotExtractionResult;
        if (cReusedB) {
          C = B;
          console.log(`[${index + 1}/${inputBundles.length}] ${key}: C input equals B; reused without a paid call`);
        } else {
          console.log(`[${index + 1}/${inputBundles.length}] ${key}: extracting C with attachments`);
          C = await extractVariant(bundle.entry, bundle.inputs.apiPlusAttachments, apiKey!);
        }

        const variantA = buildGrantAnalysisPilotVariant({
          variant: "A",
          entry: bundle.entry,
          inputs: bundle.inputs,
          criteria: bundle.entry.criteria,
          extractorVersion: resolveGrantExtractionManifest(bundle.entry).extractorVersion,
        });
        const variantB = buildGrantAnalysisPilotVariant({
          variant: "B",
          entry: bundle.entry,
          inputs: bundle.inputs,
          criteria: B.criteria,
          axes: B.axes,
          extractorVersion: GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
        });
        const variantC = buildGrantAnalysisPilotVariant({
          variant: "C",
          entry: bundle.entry,
          inputs: bundle.inputs,
          criteria: C.criteria,
          axes: C.axes,
          extractorVersion: GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
        });
        const variants = { A: variantA, B: variantB, C: variantC };
        const matches = {
          A: buildGrantAnalysisShadowMatch({ entry: bundle.entry, criteria: bundle.entry.criteria, company: profileResolution.profile, asOf: profileAsOf }),
          B: buildGrantAnalysisShadowMatch({ entry: bundle.entry, criteria: B.criteria, company: profileResolution.profile, asOf: profileAsOf }),
          C: buildGrantAnalysisShadowMatch({ entry: bundle.entry, criteria: C.criteria, company: profileResolution.profile, asOf: profileAsOf }),
        };
        const record: PilotGrantRecord = {
          recordType: "grant_analysis_pilot_result",
          pilotRunVersion: PILOT_RUN_VERSION,
          generatedAt: new Date().toISOString(),
          asOf: asOf.toISOString(),
          profileAsOf: profileAsOf.toISOString(),
          bizNo,
          profileHash,
          cohort: bundle.cohort,
          inputAudit: bundle.inputs,
          referenceText: bundle.inputs.apiPlusAttachments.input.text,
          extractions: { B, C, cReusedB },
          variants,
          comparison: compareGrantAnalysisPilotVariants([variantA, variantB, variantC]),
          matches,
          criteriaCounts: {
            A: bundle.entry.criteria.length,
            B: B.criteria.length,
            C: C.criteria.length,
          },
          externalCalls: [
            callReceipt("B", B, false),
            callReceipt("C", C, cReusedB),
          ],
          databaseWriteMode: false,
          operationalReady: false,
        };
        writeJsonAtomic(checkpointPath, record);
        records.push(record);
      } catch (error) {
        const failure: PilotGrantFailure = {
          recordType: "grant_analysis_pilot_failure",
          pilotRunVersion: PILOT_RUN_VERSION,
          generatedAt: new Date().toISOString(),
          grantKey: key,
          sourceRevision: bundle.inputs.sourceRevision,
          error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
          databaseWriteMode: false,
        };
        writeJsonAtomic(checkpointPath, failure);
        failures.push(failure);
        console.error(`[${index + 1}/${inputBundles.length}] ${key}: failed: ${failure.error.split("\n")[0]}`);
      }
    }

    const orderedRecords = orderRecords(records);
    const aggregate = aggregatePilot(orderedRecords, failures, {
      priorConfirmedFailedCalls,
      priorInterruptedCalls,
    });
    writeArtifacts({ outputDir, records: orderedRecords, failures, aggregate });
    console.log(JSON.stringify({
      mode: "extract",
      pilotRunVersion: PILOT_RUN_VERSION,
      asOf: asOf.toISOString(),
      profileAsOf: profileAsOf.toISOString(),
      databaseWriteMode: false,
      operationalReady: false,
      outputDir,
      ...aggregate,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

interface PilotCallReceipt {
  variant: "B" | "C";
  externalCall: boolean;
  reusedFrom?: "B";
  model: string;
  promptInputSha256: string;
  promptCharacters: number;
  usage: Record<string, unknown> | null;
}

interface PilotGrantRecord {
  recordType: "grant_analysis_pilot_result";
  pilotRunVersion: string;
  generatedAt: string;
  asOf: string;
  profileAsOf: string;
  bizNo: string;
  profileHash: string;
  cohort: FrozenGrantAnalysisPilotEntry;
  inputAudit: GrantAnalysisPilotInputs;
  referenceText: string;
  extractions: {
    B: GrantAnalysisPilotExtractionResult;
    C: GrantAnalysisPilotExtractionResult;
    cReusedB: boolean;
  };
  variants: { A: GrantAnalysisPilotVariant; B: GrantAnalysisPilotVariant; C: GrantAnalysisPilotVariant };
  comparison: GrantAnalysisPilotComparison;
  matches: { A: MatchResult; B: MatchResult; C: MatchResult };
  criteriaCounts: { A: number; B: number; C: number };
  externalCalls: PilotCallReceipt[];
  databaseWriteMode: false;
  operationalReady: false;
}

interface PilotGrantFailure {
  recordType: "grant_analysis_pilot_failure";
  pilotRunVersion: string;
  generatedAt: string;
  grantKey: string;
  sourceRevision: string;
  error: string;
  databaseWriteMode: false;
}

function reprocessPilotRecord(options: {
  checkpoint: PilotGrantRecord;
  entry: NormalizedGrant<unknown>;
  inputs: GrantAnalysisPilotInputs;
  company: CompanyProfile;
  profileHash: string;
}): PilotGrantRecord {
  const B = options.checkpoint.extractions.B;
  const C = options.checkpoint.extractions.C;
  const variantA = buildGrantAnalysisPilotVariant({
    variant: "A",
    entry: options.entry,
    inputs: options.inputs,
    criteria: options.entry.criteria,
    extractorVersion: resolveGrantExtractionManifest(options.entry).extractorVersion,
  });
  const variantB = buildGrantAnalysisPilotVariant({
    variant: "B",
    entry: options.entry,
    inputs: options.inputs,
    criteria: B.criteria,
    axes: B.axes,
    extractorVersion: GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
  });
  const variantC = buildGrantAnalysisPilotVariant({
    variant: "C",
    entry: options.entry,
    inputs: options.inputs,
    criteria: C.criteria,
    axes: C.axes,
    extractorVersion: GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
  });
  return {
    ...options.checkpoint,
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    profileAsOf: profileAsOf.toISOString(),
    profileHash: options.profileHash,
    inputAudit: options.inputs,
    referenceText: options.inputs.apiPlusAttachments.input.text,
    variants: { A: variantA, B: variantB, C: variantC },
    comparison: compareGrantAnalysisPilotVariants([variantA, variantB, variantC]),
    matches: {
      A: buildGrantAnalysisShadowMatch({ entry: options.entry, criteria: options.entry.criteria, company: options.company, asOf: profileAsOf }),
      B: buildGrantAnalysisShadowMatch({ entry: options.entry, criteria: B.criteria, company: options.company, asOf: profileAsOf }),
      C: buildGrantAnalysisShadowMatch({ entry: options.entry, criteria: C.criteria, company: options.company, asOf: profileAsOf }),
    },
    criteriaCounts: { A: options.entry.criteria.length, B: B.criteria.length, C: C.criteria.length },
  };
}

interface PilotAggregate {
  completedGrantCount: number;
  failedGrantCount: number;
  externalLlmCallCount: number;
  priorConfirmedFailedLlmCallCount: number;
  interruptedLlmCallCount: number;
  confirmedTotalExternalLlmCallCount: number;
  possibleTotalExternalLlmCallCount: number;
  reusedCCount: number;
  attachmentComparedGrantCount: number;
  attachmentComparedWithoutOutputCapCount: number;
  outputCapReachedGrantKeys: string[];
  openMatchKpiGrantCount: number;
  meanAxisInspectionCoverage: { A: number | null; B: number | null; C: number | null };
  meanAxisResolutionCoverage: { A: number | null; B: number | null; C: number | null };
  totalCriteria: { A: number; B: number; C: number };
  transitionTotals: {
    AtoB: ReturnType<typeof emptyTransition>;
    BtoC: ReturnType<typeof emptyTransition>;
  };
  nonTruncatedAttachmentComparison: {
    grantCount: number;
    meanInspectionCoverage: { B: number | null; C: number | null };
    meanResolutionCoverage: { B: number | null; C: number | null };
    totalCriteria: { B: number; C: number };
    BtoC: ReturnType<typeof emptyTransition>;
  };
  openMatchTierChanges: { AtoB: number; BtoC: number };
  usageTotals: Record<string, number>;
  hypothesisStatus: "awaiting_blind_review";
}

function freezeAndSelect(
  universe: Array<NormalizedGrant<unknown>>,
  cohort: readonly FrozenGrantAnalysisPilotEntry[],
): Array<{ cohort: FrozenGrantAnalysisPilotEntry; entry: NormalizedGrant<unknown> }> {
  const byKey = new Map(universe.map((entry) => [`${entry.grant.source}:${entry.grant.source_id}`, entry]));
  return cohort.map((frozen) => {
    const key = frozenGrantAnalysisPilotKey(frozen);
    const entry = byKey.get(key);
    if (!entry) throw new Error(`Frozen pilot grant is no longer in the active canonical universe: ${key}`);
    const revision = resolveGrantExtractionManifest(entry).revision;
    if (revision !== frozen.sourceRevision) {
      throw new Error(`${key}: source revision drifted; expected ${frozen.sourceRevision}, got ${revision}`);
    }
    if (entry.grant.title !== frozen.title) throw new Error(`${key}: title drifted after cohort freeze`);
    if (entry.grant.status !== frozen.status) throw new Error(`${key}: status drifted after cohort freeze`);
    const applyEnd = entry.grant.apply_end?.slice(0, 10) ?? null;
    if (applyEnd !== frozen.applyEnd) throw new Error(`${key}: apply_end drifted after cohort freeze`);
    return { cohort: { ...frozen }, entry };
  });
}

async function extractVariant(
  entry: NormalizedGrant<unknown>,
  inputVariant: GrantAnalysisPilotInputVariant,
  apiKey: string,
): Promise<GrantAnalysisPilotExtractionResult> {
  const input = inputVariant.input;
  if (entry.grant.source === "kstartup" && input.source === "kstartup") {
    return extractGrantAnalysisPilotWithAnthropic({
      source: "kstartup",
      payload: entry.raw.payload as KStartupAnnouncement,
      input,
      apiKey,
    });
  }
  if (entry.grant.source === "bizinfo" && input.source === "bizinfo") {
    return extractGrantAnalysisPilotWithAnthropic({
      source: "bizinfo",
      payload: entry.raw.payload as BizInfoProgram,
      input,
      apiKey,
    });
  }
  throw new Error(`${entry.grant.source}:${entry.grant.source_id}: input source mismatch`);
}

function callReceipt(
  variant: "B" | "C",
  result: GrantAnalysisPilotExtractionResult,
  reused: boolean,
): PilotCallReceipt {
  return {
    variant,
    externalCall: !reused,
    ...(reused ? { reusedFrom: "B" as const } : {}),
    model: result.model,
    promptInputSha256: result.prompt.inputSha256,
    promptCharacters: result.prompt.includedCharacters,
    usage: result.usage,
  };
}

function aggregatePilot(
  records: PilotGrantRecord[],
  failures: PilotGrantFailure[],
  priorCalls: { priorConfirmedFailedCalls: number; priorInterruptedCalls: number },
): PilotAggregate {
  const attachmentCompared = records.filter((record) => !record.extractions.cReusedB);
  const outputCapReachedRecords = attachmentCompared.filter((record) => outputCapReached(record.extractions.C));
  const nonTruncatedAttachmentRecords = attachmentCompared.filter((record) => !outputCapReached(record.extractions.C));
  const openRecords = records.filter((record) => record.cohort.includeInOpenMatchKpi);
  const successfulCalls = records.flatMap((record) => record.externalCalls).filter((call) => call.externalCall).length;
  return {
    completedGrantCount: records.length,
    failedGrantCount: failures.length,
    externalLlmCallCount: successfulCalls,
    priorConfirmedFailedLlmCallCount: priorCalls.priorConfirmedFailedCalls,
    interruptedLlmCallCount: priorCalls.priorInterruptedCalls,
    confirmedTotalExternalLlmCallCount: successfulCalls + priorCalls.priorConfirmedFailedCalls,
    possibleTotalExternalLlmCallCount:
      successfulCalls + priorCalls.priorConfirmedFailedCalls + priorCalls.priorInterruptedCalls,
    reusedCCount: records.filter((record) => record.extractions.cReusedB).length,
    attachmentComparedGrantCount: attachmentCompared.length,
    attachmentComparedWithoutOutputCapCount: nonTruncatedAttachmentRecords.length,
    outputCapReachedGrantKeys: outputCapReachedRecords.map((record) => frozenGrantAnalysisPilotKey(record.cohort)),
    openMatchKpiGrantCount: openRecords.length,
    meanAxisInspectionCoverage: variantMeans(records, (record, variant) =>
      record.comparison.summaries[variant].axes.inspectionCoverage),
    meanAxisResolutionCoverage: variantMeans(records, (record, variant) =>
      record.comparison.summaries[variant].axes.resolutionCoverage),
    totalCriteria: {
      A: sum(records.map((record) => record.criteriaCounts.A)),
      B: sum(records.map((record) => record.criteriaCounts.B)),
      C: sum(records.map((record) => record.criteriaCounts.C)),
    },
    transitionTotals: {
      AtoB: sumTransitions(records.map((record) => record.comparison.transitions.AtoB)),
      BtoC: sumTransitions(attachmentCompared.map((record) => record.comparison.transitions.BtoC)),
    },
    nonTruncatedAttachmentComparison: {
      grantCount: nonTruncatedAttachmentRecords.length,
      meanInspectionCoverage: {
        B: mean(nonTruncatedAttachmentRecords.map((record) => record.comparison.summaries.B.axes.inspectionCoverage)),
        C: mean(nonTruncatedAttachmentRecords.map((record) => record.comparison.summaries.C.axes.inspectionCoverage)),
      },
      meanResolutionCoverage: {
        B: mean(nonTruncatedAttachmentRecords.map((record) => record.comparison.summaries.B.axes.resolutionCoverage)),
        C: mean(nonTruncatedAttachmentRecords.map((record) => record.comparison.summaries.C.axes.resolutionCoverage)),
      },
      totalCriteria: {
        B: sum(nonTruncatedAttachmentRecords.map((record) => record.criteriaCounts.B)),
        C: sum(nonTruncatedAttachmentRecords.map((record) => record.criteriaCounts.C)),
      },
      BtoC: sumTransitions(nonTruncatedAttachmentRecords.map((record) => record.comparison.transitions.BtoC)),
    },
    openMatchTierChanges: {
      AtoB: openRecords.filter((record) => tier(record.matches.A) !== tier(record.matches.B)).length,
      BtoC: openRecords.filter((record) => tier(record.matches.B) !== tier(record.matches.C)).length,
    },
    usageTotals: usageTotals(records),
    hypothesisStatus: "awaiting_blind_review",
  };
}

function writeArtifacts(options: {
  outputDir: string;
  records: PilotGrantRecord[];
  failures: PilotGrantFailure[];
  aggregate: PilotAggregate;
}): void {
  mkdirSync(options.outputDir, { recursive: true });
  writeTextAtomic(join(options.outputDir, "results.jsonl"), [
    ...options.records.map((record) => JSON.stringify(record)),
    ...options.failures.map((failure) => JSON.stringify(failure)),
  ].join("\n") + "\n");
  writeJsonAtomic(join(options.outputDir, "summary.json"), {
    recordType: "grant_analysis_pilot_summary",
    pilotRunVersion: PILOT_RUN_VERSION,
    generatedAt: new Date().toISOString(),
    databaseWriteMode: false,
    operationalReady: false,
    aggregate: options.aggregate,
    failures: options.failures,
  });
  const review = buildBlindReview(options.records);
  writeTextAtomic(
    join(options.outputDir, "blind-review-tasks.jsonl"),
    review.tasks.map((task) => JSON.stringify(task)).join("\n") + "\n",
  );
  writeJsonAtomic(join(options.outputDir, "blind-review-key.json"), review.key);
  writeTextAtomic(join(options.outputDir, "report.md"), renderMarkdownReport(options.records, options.aggregate));
  writeTextAtomic(join(options.outputDir, "axis-dashboard.html"), renderAxisDashboard(options.records, options.aggregate));
}

function buildBlindReview(records: PilotGrantRecord[]) {
  const key: Record<string, Record<string, "A" | "B" | "C">> = {};
  const tasks = records.map((record) => {
    const grantKey = frozenGrantAnalysisPilotKey(record.cohort);
    const taskId = `review-${sha256(grantKey).slice(0, 12)}`;
    const candidates = (["A", "B", "C"] as const).map((variant) => {
      const candidateId = `candidate-${sha256(`${grantKey}:${variant}`).slice(0, 10)}`;
      key[taskId] ??= {};
      key[taskId]![candidateId] = variant;
      return {
        candidateId,
        criteria: criteriaForVariant(record, variant),
        axes: record.variants[variant].axes.map((axis) => ({
          dimension: axis.dimension,
          state: axis.state,
          note: axis.note ?? null,
          criterionCount: axis.criteria.length,
        })),
        match: compactMatch(record.matches[variant]),
      };
    }).sort((left, right) => sha256(`${taskId}:${left.candidateId}`).localeCompare(sha256(`${taskId}:${right.candidateId}`)));
    return {
      recordType: "grant_analysis_blind_review_task",
      taskId,
      grant: {
        source: record.cohort.source,
        sourceId: record.cohort.sourceId,
        title: record.cohort.title,
        sourceRevision: record.cohort.sourceRevision,
      },
      referenceText: record.referenceText,
      candidates,
      annotation: {
        bestCandidateId: null,
        criterionPrecision: null,
        criterionRecall: null,
        axisStateAccuracy: null,
        matchVerdictCorrect: null,
        falsePositiveDimensions: [],
        missedDimensions: [],
        notes: "",
      },
    };
  });
  return {
    tasks,
    key: {
      recordType: "grant_analysis_blind_review_key",
      warning: "Do not expose this file to the reviewer before annotations are frozen.",
      candidates: key,
    },
  };
}

function renderMarkdownReport(records: PilotGrantRecord[], aggregate: PilotAggregate): string {
  const rows = records.map((record) => {
    const key = frozenGrantAnalysisPilotKey(record.cohort);
    return `| ${key} | ${record.criteriaCounts.A} | ${record.criteriaCounts.B} | ${record.criteriaCounts.C} | ${percent(record.comparison.summaries.A.axes.inspectionCoverage)} | ${percent(record.comparison.summaries.B.axes.inspectionCoverage)} | ${percent(record.comparison.summaries.C.axes.inspectionCoverage)} | ${record.inputAudit.attachments.characters.includedAttachmentMarkdown} | ${tier(record.matches.A)} → ${tier(record.matches.B)} → ${tier(record.matches.C)} |`;
  });
  return [
    "# 공고 22축 분석 A/B/C 파일럿",
    "",
    `- 기준시각: ${GRANT_ANALYSIS_PILOT_AS_OF}`,
    `- 완료/실패: ${aggregate.completedGrantCount}/${aggregate.failedGrantCount}`,
    `- 성공 결과에 포함된 외부 LLM 호출: ${aggregate.externalLlmCallCount}회`,
    `- 계약 실패 후 재시도까지 포함한 확인된 총 호출: ${aggregate.confirmedTotalExternalLlmCallCount}회 (중단 시점 호출 ${aggregate.interruptedLlmCallCount}회는 과금 여부 불명)`,
    `- 첨부가 실제 입력된 B/C 비교군: ${aggregate.attachmentComparedGrantCount}건`,
    `- 출력 상한 미도달 첨부 비교군: ${aggregate.attachmentComparedWithoutOutputCapCount}건 (상한 도달: ${aggregate.outputCapReachedGrantKeys.join(", ") || "없음"})`,
    "- DB 쓰기: 없음",
    "- 판정 상태: 블라인드 사람 검수 전이므로 운영 반영 불가",
    "",
    "| 공고 | A criteria | B criteria | C criteria | A 검사율 | B 검사율 | C 검사율 | C 첨부문자 | shadow tier |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...rows,
    "",
    "## 전체 요약",
    "",
    `- 평균 검사율 A/B/C: ${percent(aggregate.meanAxisInspectionCoverage.A)} / ${percent(aggregate.meanAxisInspectionCoverage.B)} / ${percent(aggregate.meanAxisInspectionCoverage.C)}`,
    `- 평균 해소율 A/B/C: ${percent(aggregate.meanAxisResolutionCoverage.A)} / ${percent(aggregate.meanAxisResolutionCoverage.B)} / ${percent(aggregate.meanAxisResolutionCoverage.C)}`,
    `- criteria 총수 A/B/C: ${aggregate.totalCriteria.A} / ${aggregate.totalCriteria.B} / ${aggregate.totalCriteria.C}`,
    `- A→B 신규 검사 축: ${aggregate.transitionTotals.AtoB.newlyInspected}, 신규 해소 축: ${aggregate.transitionTotals.AtoB.newlyResolved}`,
    `- 첨부 비교군 B→C criteria 추가: ${aggregate.transitionTotals.BtoC.criteriaAdded}, 신규 해소 축: ${aggregate.transitionTotals.BtoC.newlyResolved}`,
    `- 출력 상한 미도달 첨부 ${aggregate.nonTruncatedAttachmentComparison.grantCount}건 B/C 검사율: ${percent(aggregate.nonTruncatedAttachmentComparison.meanInspectionCoverage.B)} / ${percent(aggregate.nonTruncatedAttachmentComparison.meanInspectionCoverage.C)}, criteria: ${aggregate.nonTruncatedAttachmentComparison.totalCriteria.B} / ${aggregate.nonTruncatedAttachmentComparison.totalCriteria.C}`,
    "",
    "정확도 가설의 최종 채택/기각은 `blind-review-tasks.jsonl`을 먼저 채운 뒤 `blind-review-key.json`을 열어 비교해야 합니다.",
    "",
  ].join("\n");
}

function renderAxisDashboard(records: PilotGrantRecord[], aggregate: PilotAggregate): string {
  const data = records.map((record) => ({
    key: frozenGrantAnalysisPilotKey(record.cohort),
    title: record.cohort.title,
    stratum: record.cohort.stratum,
    criteriaCounts: record.criteriaCounts,
    attachment: record.inputAudit.attachments,
    summaries: record.comparison.summaries,
    axes: record.comparison.axes,
    transitions: record.comparison.transitions,
    matches: {
      A: compactMatch(record.matches.A),
      B: compactMatch(record.matches.B),
      C: compactMatch(record.matches.C),
    },
    outputCapReached: outputCapReached(record.extractions.C),
  }));
  const embedded = JSON.stringify({ aggregate, grants: data }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>공고 22축 분석 파일럿</title>
<style>
:root{font-family:Inter,Pretendard,system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1240px;margin:auto;padding:36px 24px 64px}h1{font-size:28px;margin:0 0 8px}.muted{color:#697386}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.card,.panel{background:#fff;border:1px solid #e5e9f2;border-radius:16px;box-shadow:0 4px 18px #21325b0a}.card{padding:18px}.value{font-size:26px;font-weight:750;margin-top:8px}.panel{padding:20px;margin-top:16px}select{width:100%;padding:13px;border:1px solid #cad2e1;border-radius:10px;background:#fff;font-size:15px}.meta{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}.pill{padding:5px 9px;border-radius:999px;background:#eef3ff;color:#2859c5;font-size:12px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.variant{padding:14px;background:#f8faff;border-radius:12px}.variant b{font-size:18px}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{text-align:left;padding:10px;border-bottom:1px solid #edf0f5;vertical-align:top}th{position:sticky;top:0;background:#fff;color:#596273}.state{display:inline-block;padding:4px 7px;border-radius:7px;font-weight:650}.structured,.explicit_no_condition{background:#e5f8ef;color:#087a4c}.text_only,.evidence_missing{background:#fff3d7;color:#8a5b00}.not_inspected,.failed{background:#ffe8e8;color:#a23535}.reserved{background:#eceff4;color:#667085}@media(max-width:800px){.cards,.grid{grid-template-columns:1fr 1fr}.wrap{padding:24px 12px}}@media(max-width:520px){.cards,.grid{grid-template-columns:1fr}}
</style></head><body><main class="wrap"><h1>공고 22축 분석 A/B/C 파일럿</h1><p class="muted">A 현재 분류 · B API 재추출 · C API+첨부 재추출. 블라인드 검수 전 초안이며 DB에는 반영되지 않았습니다.</p>
<section class="cards" id="cards"></section><section class="panel"><label for="grant"><b>공고 선택</b></label><select id="grant"></select><div id="detail"></div></section></main>
<script>const DATA=${embedded};
const pct=v=>v==null?'—':Math.round(v*100)+'%';const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.querySelector('#cards').innerHTML=[['완료 공고',DATA.aggregate.completedGrantCount],['외부 LLM 호출',DATA.aggregate.externalLlmCallCount],['첨부 비교군',DATA.aggregate.attachmentComparedGrantCount],['A→B 신규 해소 축',DATA.aggregate.transitionTotals.AtoB.newlyResolved]].map(([k,v])=>'<div class="card"><span class="muted">'+k+'</span><div class="value">'+v+'</div></div>').join('');
const sel=document.querySelector('#grant');sel.innerHTML=DATA.grants.map((g,i)=>'<option value="'+i+'">'+esc(g.key+' · '+g.title)+'</option>').join('');sel.onchange=render;
function render(){const g=DATA.grants[Number(sel.value)||0];const variants=['A','B','C'];document.querySelector('#detail').innerHTML='<div class="meta"><span class="pill">'+esc(g.stratum)+'</span><span class="pill">첨부 '+g.attachment.counts.included+'개 / '+g.attachment.characters.includedAttachmentMarkdown+'자</span></div><h2>'+esc(g.title)+'</h2><div class="grid">'+variants.map(v=>'<div class="variant"><b>'+v+'</b><p>criteria '+g.criteriaCounts[v]+' · 검사 '+pct(g.summaries[v].axes.inspectionCoverage)+' · 해소 '+pct(g.summaries[v].axes.resolutionCoverage)+'</p><p class="muted">'+esc(g.matches[v].tier)+' · '+esc(g.matches[v].eligibility)+' · 근거 '+g.matches[v].evidenceCoverage+'%</p></div>').join('')+'</div><table><thead><tr><th>축</th><th>A 현재</th><th>B API</th><th>C API+첨부</th><th>B→C 변화</th></tr></thead><tbody>'+g.axes.map(a=>'<tr><td><b>'+esc(a.dimension)+'</b><br><span class="muted">'+esc(a.role)+'</span></td>'+variants.map(v=>'<td><span class="state '+esc(a.states[v])+'">'+esc(a.states[v])+'</span><br><span class="muted">criteria '+a.criterionCounts[v]+' · 근거 '+a.evidenceBackedCriterionCounts[v]+'</span></td>').join('')+'<td>+'+a.deltas.BtoC.added+' / −'+a.deltas.BtoC.removed+'<br><span class="muted">근거 +'+a.deltas.BtoC.evidenceGained+' / −'+a.deltas.BtoC.evidenceLost+'</span></td></tr>').join('')+'</tbody></table>';}render();</script></body></html>`;
}

function criteriaForVariant(record: PilotGrantRecord, variant: "A" | "B" | "C") {
  if (variant === "A") return record.variants.A.axes.flatMap((axis) => axis.criteria);
  return record.extractions[variant].criteria;
}

function compactMatch(match: MatchResult) {
  return {
    eligibility: match.eligibility,
    tier: tier(match),
    verificationCompleteness: match.quality.verificationCompleteness,
    evidenceCoverage: match.quality.evidenceCoverage,
    extractionReadiness: match.quality.extractionReadiness,
    relevanceScore: match.ranking?.relevanceScore ?? null,
    priorityScore: match.ranking?.priorityScore ?? null,
    unknownFields: match.unknown_fields,
    reviewReasons: match.review_gate?.reasons ?? [],
  };
}

function outputCapReached(result: GrantAnalysisPilotExtractionResult): boolean {
  const outputTokens = result.usage?.output_tokens;
  return typeof outputTokens === "number" && outputTokens >= 5_000;
}

function tier(match: MatchResult): string {
  return match.review_gate?.tier ?? (match.eligibility === "eligible"
    ? "recommendable"
    : match.eligibility === "ineligible"
      ? "not_recommended"
      : "needs_profile_input");
}

function variantMeans(
  records: PilotGrantRecord[],
  read: (record: PilotGrantRecord, variant: "A" | "B" | "C") => number | null,
): { A: number | null; B: number | null; C: number | null } {
  return {
    A: mean(records.map((record) => read(record, "A"))),
    B: mean(records.map((record) => read(record, "B"))),
    C: mean(records.map((record) => read(record, "C"))),
  };
}

function emptyTransition() {
  return {
    axisStateChanges: 0,
    newlyInspected: 0,
    newlyResolved: 0,
    regressions: 0,
    criteriaAdded: 0,
    criteriaRemoved: 0,
    evidenceGained: 0,
    evidenceLost: 0,
  };
}

function sumTransitions(transitions: Array<ReturnType<typeof emptyTransition>>) {
  return transitions.reduce((total, transition) => {
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += transition[key];
    return total;
  }, emptyTransition());
}

function usageTotals(records: PilotGrantRecord[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const call of records.flatMap((record) => record.externalCalls).filter((entry) => entry.externalCall)) {
    for (const [key, value] of Object.entries(call.usage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

function orderRecords(records: PilotGrantRecord[]): PilotGrantRecord[] {
  const order = new Map(FROZEN_GRANT_ANALYSIS_PILOT_COHORT.map((entry, index) => [frozenGrantAnalysisPilotKey(entry), index]));
  return [...records].sort((left, right) =>
    (order.get(frozenGrantAnalysisPilotKey(left.cohort)) ?? 999) -
    (order.get(frozenGrantAnalysisPilotKey(right.cohort)) ?? 999));
}

function assertCheckpoint(checkpoint: PilotGrantRecord | PilotGrantFailure, cohort: FrozenGrantAnalysisPilotEntry): void {
  if (checkpoint.pilotRunVersion !== PILOT_RUN_VERSION) throw new Error("Checkpoint pilot version mismatch; use --no-resume.");
  const key = frozenGrantAnalysisPilotKey(cohort);
  const checkpointKey = checkpoint.recordType === "grant_analysis_pilot_result"
    ? frozenGrantAnalysisPilotKey(checkpoint.cohort)
    : checkpoint.grantKey;
  const revision = checkpoint.recordType === "grant_analysis_pilot_result"
    ? checkpoint.cohort.sourceRevision
    : checkpoint.sourceRevision;
  if (checkpointKey !== key || revision !== cohort.sourceRevision) {
    throw new Error(`${key}: checkpoint identity/revision mismatch`);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function csvArg(value: string | undefined): string[] {
  return value ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))] : [];
}

function nonNegativeIntegerArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 1_000) / 10}%`;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.round((sum(present) / present.length) * 10_000) / 10_000;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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

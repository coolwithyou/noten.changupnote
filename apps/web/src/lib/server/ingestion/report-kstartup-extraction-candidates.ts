import type { CriterionDimension } from "@cunote/contracts";
import { buildKStartupExtractionInput, type KStartupAnnouncement } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const limit = boundedInteger(readArg("limit"), 2_000, 1, 2_000);
const sampleLimit = boundedInteger(readArg("samples"), 30, 0, 100);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<KStartupAnnouncement>({ dialect: "drizzle", client: db });
  const loaded = await repositories.grants.listActiveGrants({ limit, asOf });
  const grants = loaded.filter((entry) => entry.grant.source === "kstartup");
  const candidates = grants.flatMap((entry) => {
    const textOnlyDimensions = unique(entry.criteria
      .filter((criterion) =>
        criterion.operator === "text_only" &&
        (criterion.kind === "required" || criterion.kind === "exclusion"))
      .map((criterion) => criterion.dimension));
    if (textOnlyDimensions.length === 0) return [];
    const input = buildKStartupExtractionInput(entry.raw.payload);
    const convertedAttachments = entry.raw.attachments?.filter((attachment) =>
      attachment.conversion?.status === "converted").length ?? 0;
    return [{
      sourceId: entry.grant.source_id,
      title: entry.grant.title,
      textOnlyDimensions,
      inputBlockCount: input.blocks.length,
      inputCharacters: input.text.length,
      sourceFields: unique(input.blocks.flatMap((block) => block.source_field ? [String(block.source_field)] : [])),
      hasDetail: Boolean(entry.raw.payload.detail),
      convertedAttachments,
      priority: candidatePriority(textOnlyDimensions, input.blocks.length, Boolean(entry.raw.payload.detail), convertedAttachments),
    }];
  }).sort((left, right) => right.priority - left.priority || right.inputCharacters - left.inputCharacters);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    loadedGrantCount: loaded.length,
    kstartupGrantCount: grants.length,
    candidateCount: candidates.length,
    detailCandidateCount: candidates.filter((candidate) => candidate.hasDetail).length,
    convertedAttachmentCandidateCount: candidates.filter((candidate) => candidate.convertedAttachments > 0).length,
    dimensionCounts: histogram(candidates.flatMap((candidate) => candidate.textOnlyDimensions)),
    sourceFieldCounts: histogram(candidates.flatMap((candidate) => candidate.sourceFields)),
    samples: candidates.slice(0, sampleLimit),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function candidatePriority(
  dimensions: CriterionDimension[],
  blockCount: number,
  hasDetail: boolean,
  convertedAttachments: number,
): number {
  const core = dimensions.filter((dimension) =>
    dimension === "industry" || dimension === "size" || dimension === "certification" || dimension === "target_type").length;
  return core * 20 + Math.min(20, blockCount * 2) + (hasDetail ? 15 : 0) + Math.min(25, convertedAttachments * 10);
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}

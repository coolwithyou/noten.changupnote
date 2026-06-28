import type { GrantSource, NormalizedGrant } from "@cunote/contracts";
import { hashGrantRawPayload } from "./grantRawHash";

export interface ExistingGrantRawHash {
  sourceId: string;
  rawHash: string | null;
}

export interface GrantArchivePlan {
  source: GrantSource;
  fetchedCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  publishableCount: number;
  criteriaCount: number;
  publishableCriteriaCount: number;
  skipUnchanged: boolean;
  rawHashes: string[];
  newSourceIds: string[];
  changedSourceIds: string[];
  unchangedSourceIds: string[];
  publishableSourceIds: string[];
}

export function planGrantArchivePublication<TPayload>(
  source: GrantSource,
  entries: Array<NormalizedGrant<TPayload>>,
  existingHashes: ExistingGrantRawHash[] = [],
  options: { skipUnchanged?: boolean } = {},
): GrantArchivePlan {
  assertEntriesUseSource(source, entries);

  const skipUnchanged = options.skipUnchanged ?? true;
  const existingBySourceId = new Map(existingHashes.map((row) => [row.sourceId, row.rawHash]));
  const newSourceIds: string[] = [];
  const changedSourceIds: string[] = [];
  const unchangedSourceIds: string[] = [];
  const publishableSourceIds: string[] = [];
  const rawHashes: string[] = [];
  let criteriaCount = 0;
  let publishableCriteriaCount = 0;

  for (const entry of entries) {
    const hash = hashGrantRawPayload(entry.raw.payload);
    const existingHash = existingBySourceId.get(entry.raw.source_id);
    const isKnown = existingBySourceId.has(entry.raw.source_id);
    const isUnchanged = isKnown && existingHash === hash;
    const isChanged = isKnown && existingHash !== hash;
    const isNew = !isKnown;
    const publishable = !skipUnchanged || !isUnchanged;

    rawHashes.push(hash);
    criteriaCount += entry.criteria.length;
    if (isNew) newSourceIds.push(entry.raw.source_id);
    if (isChanged) changedSourceIds.push(entry.raw.source_id);
    if (isUnchanged) unchangedSourceIds.push(entry.raw.source_id);
    if (publishable) {
      publishableSourceIds.push(entry.raw.source_id);
      publishableCriteriaCount += entry.criteria.length;
    }
  }

  return {
    source,
    fetchedCount: entries.length,
    newCount: newSourceIds.length,
    changedCount: changedSourceIds.length,
    unchangedCount: unchangedSourceIds.length,
    publishableCount: publishableSourceIds.length,
    criteriaCount,
    publishableCriteriaCount,
    skipUnchanged,
    rawHashes,
    newSourceIds,
    changedSourceIds,
    unchangedSourceIds,
    publishableSourceIds,
  };
}

export function selectPublishableArchiveEntries<TPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
  plan: Pick<GrantArchivePlan, "publishableSourceIds">,
): Array<NormalizedGrant<TPayload>> {
  const publishable = new Set(plan.publishableSourceIds);
  return entries.filter((entry) => publishable.has(entry.raw.source_id));
}

function assertEntriesUseSource<TPayload>(
  source: GrantSource,
  entries: Array<NormalizedGrant<TPayload>>,
): void {
  for (const entry of entries) {
    if (entry.raw.source !== source || entry.grant.source !== source) {
      throw new Error(
        `Archive source mismatch: expected ${source}, got raw=${entry.raw.source}, grant=${entry.grant.source}, source_id=${entry.grant.source_id}`,
      );
    }
  }
}

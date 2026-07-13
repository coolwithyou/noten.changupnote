import { createHash } from "node:crypto";

export interface DedupPairEvidence {
  canonicalGrantKey: string;
  memberGrantKey: string;
  score: number;
  confirmed: boolean;
}

export interface DedupAuditEvidence {
  generatedAt: string;
  asOf: string;
  writeMode: false;
  activeGrantCountIncludingConfirmedMembers: number;
  activeGrantCountAfterConfirmedSuppression: number;
  confirmedSuppressedOccurrenceCount: number;
  autoDuplicateExcessCount: number;
  estimatedDuplicateCardExposureRate: number;
  confirmedActiveLinkCount: number;
  confirmedAutoPairCount: number;
  unconfirmedAutoPairCount: number;
  gate: {
    maximumDuplicateCardExposureRate: number;
    exposureGatePassed: boolean;
    publicationReady: boolean;
  };
  candidates: Array<{
    leftGrantKey: string;
    rightGrantKey: string;
    decision: "auto_duplicate" | "review";
    score: number;
    confirmed: boolean;
  }>;
}

export interface DedupPublishEvidence {
  dryRun: boolean;
  asOf: string;
  activeGrantCount: number;
  requestedPairs: Array<{ canonicalGrantKey: string; memberGrantKey: string }>;
  unscopedCandidateCount: number;
  candidateCount: number;
  linkCount: number;
  skippedCount: number;
  links: DedupPairEvidence[];
  resolvedLinkCount?: number;
  unresolvedKeys?: string[];
}

export interface DedupWriteBatchManifest {
  schemaVersion: "dedup-write-batch-v1";
  batchId: string;
  createdAt: string;
  asOf: string;
  authorization: {
    approved: false;
    writeStillRequiresExplicitCommandConfirmation: true;
  };
  pairs: DedupPairEvidence[];
  before: {
    activeGrantCountIncludingConfirmedMembers: number;
    activeGrantCountAfterConfirmedSuppression: number;
    confirmedSuppressedOccurrenceCount: number;
    confirmedAutoPairCount: number;
    autoDuplicateExcessCount: number;
    estimatedDuplicateCardExposureRate: number;
  };
  expected: {
    confirmedPairCount: number;
    suppressedOccurrenceCount: number;
    activeGrantCountAfterSuppression: number;
  };
  commands: {
    repeatDryRun: DedupCommandContract;
    approvedWriteTemplate: DedupCommandContract;
    afterAudit: DedupCommandContract;
    comparisonTemplate: DedupCommandContract;
  };
}

export interface DedupCommandContract {
  executable: "pnpm";
  args: string[];
  display: string;
}

export interface DedupWriteBatchComparison {
  schemaVersion: "dedup-write-batch-comparison-v1";
  batchId: string;
  comparedAt: string;
  asOf: string;
  contaminated: boolean;
  contaminationReasons: string[];
  receiptIssues: string[];
  deltas: {
    visibleActiveGrantCount: number;
    confirmedSuppressedOccurrenceCount: number;
    confirmedAutoPairCount: number;
    duplicateCardExposureRate: number;
  };
  gates: {
    comparable: boolean;
    receiptPresent: boolean;
    receiptVerified: boolean;
    allAutoPairsConfirmed: boolean;
    expectedOccurrencesSuppressed: boolean;
    visibleUniverseReducedAsExpected: boolean;
    exposureGatePassed: boolean;
    publicationReady: boolean;
    writeOutcomeVerified: boolean;
  };
}

export function buildDedupWriteBatchManifest(input: {
  audit: DedupAuditEvidence;
  dryRun: DedupPublishEvidence;
  createdAt?: Date;
}): DedupWriteBatchManifest {
  if (input.audit.writeMode !== false || input.dryRun.dryRun !== true) {
    throw new Error("dedup manifest requires read-only audit and dry-run evidence");
  }
  if (input.audit.asOf !== input.dryRun.asOf) throw new Error("dedup evidence must use the exact same asOf");
  if (input.audit.activeGrantCountIncludingConfirmedMembers !== input.dryRun.activeGrantCount) {
    throw new Error("dedup evidence must cover the same active grant universe");
  }
  const auditPairs = input.audit.candidates.filter((candidate) =>
    candidate.decision === "auto_duplicate" && !candidate.confirmed);
  const auditPairKeys = new Set(auditPairs.map((pair) => unorderedPairKey(pair.leftGrantKey, pair.rightGrantKey)));
  const links = input.dryRun.links.filter((link) =>
    link.confirmed && auditPairKeys.has(unorderedPairKey(link.canonicalGrantKey, link.memberGrantKey)));
  if (links.length === 0 || links.length > 20) throw new Error("dedup approval batch must contain 1..20 confirmed pairs");
  if (!sameUnorderedPairs(
    auditPairs.map((pair) => ({ left: pair.leftGrantKey, right: pair.rightGrantKey })),
    links.map((pair) => ({ left: pair.canonicalGrantKey, right: pair.memberGrantKey })),
  )) throw new Error("dedup audit auto pairs do not exactly match dry-run confirmed links");
  if (links.some((link) => !safeKey(link.canonicalGrantKey) || !safeKey(link.memberGrantKey))) {
    throw new Error("dedup pair contains an unsafe grant key");
  }
  if (input.audit.unconfirmedAutoPairCount !== links.length) {
    throw new Error("unconfirmed auto pair count must equal the isolated approved pair count");
  }
  const pairArgs = links.map((link) => `--pair=${link.canonicalGrantKey},${link.memberGrantKey}`);
  const common = ["--silent", "publish:dedup", "--", "--limit=2000", `--asOf=${input.audit.asOf}`, ...pairArgs];
  const stableIdentity = {
    asOf: input.audit.asOf,
    pairs: links.map((link) => ({
      canonicalGrantKey: link.canonicalGrantKey,
      memberGrantKey: link.memberGrantKey,
      score: link.score,
    })),
  };
  return {
    schemaVersion: "dedup-write-batch-v1",
    batchId: `dedup-${createHash("sha256").update(JSON.stringify(stableIdentity)).digest("hex").slice(0, 16)}`,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    asOf: input.audit.asOf,
    authorization: {
      approved: false,
      writeStillRequiresExplicitCommandConfirmation: true,
    },
    pairs: links,
    before: {
      activeGrantCountIncludingConfirmedMembers: input.audit.activeGrantCountIncludingConfirmedMembers,
      activeGrantCountAfterConfirmedSuppression: input.audit.activeGrantCountAfterConfirmedSuppression,
      confirmedSuppressedOccurrenceCount: input.audit.confirmedSuppressedOccurrenceCount,
      confirmedAutoPairCount: input.audit.confirmedAutoPairCount,
      autoDuplicateExcessCount: input.audit.autoDuplicateExcessCount,
      estimatedDuplicateCardExposureRate: input.audit.estimatedDuplicateCardExposureRate,
    },
    expected: {
      confirmedPairCount: links.length,
      suppressedOccurrenceCount: links.length,
      activeGrantCountAfterSuppression:
        input.audit.activeGrantCountAfterConfirmedSuppression - links.length,
    },
    commands: {
      repeatDryRun: command(common),
      approvedWriteTemplate: command([...common, "--write", "--confirm=PUBLISH_DEDUP_LINKS"]),
      afterAudit: command(["--silent", "report:active-grant-dedup", "--", "--limit=2000", `--asOf=${input.audit.asOf}`]),
      comparisonTemplate: command([
        "--silent", "compare:dedup-write-batch", "--",
        "--manifest=<manifest.json>", "--audit=<after-audit.json>", "--writeReceipt=<write-output.json>",
        "--require-verified",
      ]),
    },
  };
}

export function compareDedupWriteBatch(input: {
  manifest: DedupWriteBatchManifest;
  audit: DedupAuditEvidence;
  writeReceipt?: DedupPublishEvidence;
  comparedAt?: Date;
}): DedupWriteBatchComparison {
  const contaminationReasons: string[] = [];
  if (input.audit.asOf !== input.manifest.asOf) contaminationReasons.push("asof_mismatch");
  if (input.audit.activeGrantCountIncludingConfirmedMembers !== input.manifest.before.activeGrantCountIncludingConfirmedMembers) {
    contaminationReasons.push("active_grant_universe_changed");
  }
  const receiptIssues = verifyDedupWriteReceipt(input.manifest, input.writeReceipt);
  const comparable = contaminationReasons.length === 0;
  const receiptVerified = receiptIssues.length === 0;
  const allAutoPairsConfirmed = input.audit.confirmedAutoPairCount >= input.manifest.expected.confirmedPairCount &&
    input.audit.unconfirmedAutoPairCount === 0;
  const expectedOccurrencesSuppressed = input.audit.confirmedSuppressedOccurrenceCount >=
    input.manifest.before.confirmedSuppressedOccurrenceCount + input.manifest.expected.suppressedOccurrenceCount;
  const visibleUniverseReducedAsExpected = input.audit.activeGrantCountAfterConfirmedSuppression ===
    input.manifest.expected.activeGrantCountAfterSuppression;
  const writeOutcomeVerified = comparable && receiptVerified && allAutoPairsConfirmed && expectedOccurrencesSuppressed &&
    visibleUniverseReducedAsExpected && input.audit.gate.exposureGatePassed && input.audit.gate.publicationReady;
  return {
    schemaVersion: "dedup-write-batch-comparison-v1",
    batchId: input.manifest.batchId,
    comparedAt: (input.comparedAt ?? new Date()).toISOString(),
    asOf: input.manifest.asOf,
    contaminated: contaminationReasons.length > 0,
    contaminationReasons,
    receiptIssues,
    deltas: {
      visibleActiveGrantCount: input.audit.activeGrantCountAfterConfirmedSuppression -
        input.manifest.before.activeGrantCountAfterConfirmedSuppression,
      confirmedSuppressedOccurrenceCount: input.audit.confirmedSuppressedOccurrenceCount -
        input.manifest.before.confirmedSuppressedOccurrenceCount,
      confirmedAutoPairCount: input.audit.confirmedAutoPairCount - input.manifest.before.confirmedAutoPairCount,
      duplicateCardExposureRate: round4(
        input.audit.estimatedDuplicateCardExposureRate - input.manifest.before.estimatedDuplicateCardExposureRate,
      ),
    },
    gates: {
      comparable,
      receiptPresent: Boolean(input.writeReceipt),
      receiptVerified,
      allAutoPairsConfirmed,
      expectedOccurrencesSuppressed,
      visibleUniverseReducedAsExpected,
      exposureGatePassed: input.audit.gate.exposureGatePassed,
      publicationReady: input.audit.gate.publicationReady,
      writeOutcomeVerified,
    },
  };
}

export function verifyDedupWriteReceipt(
  manifest: DedupWriteBatchManifest,
  receipt: DedupPublishEvidence | undefined,
): string[] {
  if (!receipt) return ["dedup_write_receipt_missing"];
  const issues: string[] = [];
  if (receipt.dryRun !== false) issues.push("dedup_write_receipt_not_write_mode");
  if (receipt.asOf !== manifest.asOf) issues.push("dedup_write_receipt_asof_mismatch");
  if (!sameUnorderedPairs(
    receipt.requestedPairs.map((pair) => ({ left: pair.canonicalGrantKey, right: pair.memberGrantKey })),
    manifest.pairs.map((pair) => ({ left: pair.canonicalGrantKey, right: pair.memberGrantKey })),
  )) issues.push("dedup_write_receipt_scope_mismatch");
  if (!sameUnorderedPairs(
    receipt.links.map((pair) => ({ left: pair.canonicalGrantKey, right: pair.memberGrantKey })),
    manifest.pairs.map((pair) => ({ left: pair.canonicalGrantKey, right: pair.memberGrantKey })),
  )) issues.push("dedup_write_receipt_links_mismatch");
  if (receipt.links.some((link) => !link.confirmed)) issues.push("dedup_write_receipt_unconfirmed_link");
  if (receipt.resolvedLinkCount !== manifest.pairs.length || (receipt.unresolvedKeys?.length ?? 0) > 0) {
    issues.push("dedup_write_receipt_resolution_failed");
  }
  return issues;
}

function sameUnorderedPairs(
  left: Array<{ left: string; right: string }>,
  right: Array<{ left: string; right: string }>,
): boolean {
  const keys = (values: Array<{ left: string; right: string }>) => values
    .map((pair) => [pair.left, pair.right].sort().join("\u0000"))
    .sort();
  return left.length === right.length && keys(left).join("\n") === keys(right).join("\n");
}

function safeKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(value);
}

function unorderedPairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

function command(args: string[]): DedupCommandContract {
  return { executable: "pnpm", args, display: ["pnpm", ...args].join(" ") };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

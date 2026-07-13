import assert from "node:assert/strict";
import {
  buildDedupWriteBatchManifest,
  compareDedupWriteBatch,
  type DedupAuditEvidence,
  type DedupPublishEvidence,
} from "./dedupWriteBatchEvidence";

const asOf = "2026-07-12T03:00:00.000Z";
const audit: DedupAuditEvidence = {
  generatedAt: asOf,
  asOf,
  writeMode: false,
  activeGrantCountIncludingConfirmedMembers: 100,
  activeGrantCountAfterConfirmedSuppression: 100,
  confirmedSuppressedOccurrenceCount: 0,
  autoDuplicateExcessCount: 2,
  estimatedDuplicateCardExposureRate: 0.02,
  confirmedActiveLinkCount: 0,
  confirmedAutoPairCount: 0,
  unconfirmedAutoPairCount: 2,
  gate: { maximumDuplicateCardExposureRate: 0.01, exposureGatePassed: false, publicationReady: false },
  candidates: [
    { leftGrantKey: "a", rightGrantKey: "b", decision: "auto_duplicate", score: 0.9, confirmed: false },
    { leftGrantKey: "c", rightGrantKey: "d", decision: "auto_duplicate", score: 0.8, confirmed: false },
    { leftGrantKey: "e", rightGrantKey: "f", decision: "review", score: 0.8, confirmed: false },
  ],
};
const dryRun: DedupPublishEvidence = {
  dryRun: true,
  asOf,
  activeGrantCount: 100,
  requestedPairs: [],
  unscopedCandidateCount: 3,
  candidateCount: 3,
  linkCount: 3,
  skippedCount: 0,
  links: [pair("a", "b", true, 0.9), pair("c", "d", true, 0.8), pair("e", "f", false, 0.8)],
};
const manifest = buildDedupWriteBatchManifest({ audit, dryRun, createdAt: new Date(asOf) });
assert.equal(manifest.pairs.length, 2);
assert.equal(manifest.expected.activeGrantCountAfterSuppression, 98);
assert.match(manifest.commands.approvedWriteTemplate.display, /--pair=a,b/);
assert.match(manifest.commands.approvedWriteTemplate.display, /--confirm=PUBLISH_DEDUP_LINKS/);
assert.equal(manifest.authorization.approved, false);

const writeReceipt: DedupPublishEvidence = {
  dryRun: false,
  asOf,
  activeGrantCount: 100,
  requestedPairs: manifest.pairs,
  unscopedCandidateCount: 3,
  candidateCount: 2,
  linkCount: 2,
  skippedCount: 0,
  links: manifest.pairs,
  resolvedLinkCount: 2,
  unresolvedKeys: [],
};
const afterAudit: DedupAuditEvidence = {
  ...audit,
  activeGrantCountAfterConfirmedSuppression: 98,
  confirmedSuppressedOccurrenceCount: 2,
  confirmedActiveLinkCount: 2,
  confirmedAutoPairCount: 2,
  unconfirmedAutoPairCount: 0,
  gate: { maximumDuplicateCardExposureRate: 0.01, exposureGatePassed: true, publicationReady: true },
};
const comparison = compareDedupWriteBatch({ manifest, audit: afterAudit, writeReceipt });
assert.equal(comparison.gates.receiptVerified, true);
assert.equal(comparison.gates.writeOutcomeVerified, true);
assert.equal(compareDedupWriteBatch({ manifest, audit }).gates.writeOutcomeVerified, false);
assert.throws(() => buildDedupWriteBatchManifest({
  audit,
  dryRun: { ...dryRun, links: dryRun.links.slice(0, 1) },
}), /do not exactly match/);

console.log("dedup-write-batch-evidence: ok");

function pair(canonicalGrantKey: string, memberGrantKey: string, confirmed: boolean, score: number) {
  return { canonicalGrantKey, memberGrantKey, confirmed, score };
}

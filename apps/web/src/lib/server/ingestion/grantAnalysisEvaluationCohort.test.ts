import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import {
  GRANT_ANALYSIS_EVALUATION_QUOTAS,
  GRANT_ANALYSIS_EVALUATION_STRATA,
  buildGrantAnalysisAttachmentSummary,
  buildGrantAnalysisSourceRevision,
  selectGrantAnalysisEvaluationCohort,
  verifyGrantAnalysisEvaluationManifestPair,
  type GrantAnalysisEvaluationExpectedReceipt,
  type GrantAnalysisEvaluationPublicManifest,
  type GrantAnalysisEvaluationSecretManifest,
  type GrantAnalysisEvaluationSource,
  type GrantAnalysisEvaluationSplit,
  type GrantAnalysisEvaluationStratum,
} from "./grantAnalysisEvaluationCohort";
import { hashGrantRawPayload, stableJsonStringify } from "./grantRawHash";

const SEED = "ab".repeat(32);
const entries = fixturePopulation();
const EXPECTED_RECEIPT = fixtureExpectedReceipt(entries.length, 2);

const first = selectGrantAnalysisEvaluationCohort({
  entries,
  duplicateInclusiveEntries: [...entries].reverse(),
  expectedReceipt: EXPECTED_RECEIPT,
  seed: SEED,
});
const second = selectGrantAnalysisEvaluationCohort({
  entries: [...entries].reverse(),
  duplicateInclusiveEntries: entries,
  expectedReceipt: EXPECTED_RECEIPT,
  seed: SEED,
});

assert.deepEqual(first, second, "selection and both manifests must ignore repository ordering");
assert.equal(first.secretManifest.selected.length, 40);
assert.equal(first.publicManifest.validation.length, 24);
assert.equal(first.publicManifest.sealed.length, 16);
assert.equal(first.publicManifest.population.canonicalCount, 42);
assert.equal(first.publicManifest.exclusions.excludedCanonicalCount, 2);
verifyGrantAnalysisEvaluationManifestPair(
  first.publicManifest,
  first.secretManifest,
  EXPECTED_RECEIPT,
);

for (const source of ["kstartup", "bizinfo"] as const) {
  for (const stratum of GRANT_ANALYSIS_EVALUATION_STRATA) {
    const quota = GRANT_ANALYSIS_EVALUATION_QUOTAS[stratum];
    assert.equal(countSelected(first.secretManifest.selected, source, stratum, "validation"), quota.validation);
    assert.equal(countSelected(first.secretManifest.selected, source, stratum, "sealed"), quota.sealed);
  }
}

const selectedKeys = new Set(first.secretManifest.selected.map((entry) => `${entry.source}:${entry.sourceId}`));
assert.equal(selectedKeys.has("kstartup:178387"), false, "legacy K-Startup fixture must be excluded");
assert.equal(
  selectedKeys.has("bizinfo:PBLN_000000000124200"),
  false,
  "legacy BizInfo fixture must be excluded",
);

const publicJson = JSON.stringify(first.publicManifest);
assert.equal(publicJson.includes(SEED), false, "public manifest must not contain the secret seed");
assert.equal(publicJson.includes("not-committed.invalid"), false, "public manifest must not contain URLs");
assert.equal(publicJson.includes("grant-analysis/archive"), false, "public manifest must not contain storage keys");
assert.equal(publicJson.includes("not committed"), false, "public manifest must not contain conversion errors");
for (const sealed of first.secretManifest.selected.filter((entry) => entry.split === "sealed")) {
  assert.equal(publicJson.includes(sealed.sourceId), false, `public manifest leaked sealed sourceId ${sealed.sourceId}`);
  assert.equal(publicJson.includes(sealed.title), false, `public manifest leaked sealed title ${sealed.title}`);
  assert.equal(
    publicJson.includes(sealed.sourceRevision),
    false,
    `public manifest leaked sealed source revision ${sealed.sourceId}`,
  );
}
assert.ok(first.publicManifest.sealed.every((entry) => /^[a-f0-9]{64}$/.test(entry.opaqueCommitmentSha256)));
assert.ok(
  first.publicManifest.validation.every((entry) => !("selectorRankSha256" in entry)),
  "public validation entries must not expose selector ranks",
);

const firstAttachment = loadableAttachment("attachment-summary");
const attachmentPayload = { pbanc_sn: "attachment-summary", biz_pbanc_nm: "Attachment summary" };
const secondAttachment = {
  ...firstAttachment,
  source_uri: "https://changed-but-not-committed.invalid/source",
  archive_url: "https://changed-but-not-committed.invalid/archive",
  storage_key: "different/archive/location.pdf",
  fetched_at: "2099-01-01T00:00:00.000Z",
  conversion: {
    ...firstAttachment.conversion,
    markdown_url: "https://changed-but-not-committed.invalid/markdown",
    markdown_storage_key: "different/markdown/location.md",
    converted_at: "2099-01-01T00:00:00.000Z",
    error: "different ignored error",
  },
};
assert.equal(
  buildGrantAnalysisAttachmentSummary({
    source: "kstartup",
    payload: attachmentPayload,
    attachments: [firstAttachment],
  }).attachmentSummarySha256,
  buildGrantAnalysisAttachmentSummary({
    source: "kstartup",
    payload: attachmentPayload,
    attachments: [secondAttachment],
  }).attachmentSummarySha256,
  "locator values, timestamps, and errors must not affect the content commitment",
);
assert.notEqual(
  buildGrantAnalysisAttachmentSummary({
    source: "kstartup",
    payload: attachmentPayload,
    attachments: [firstAttachment],
  }).attachmentSummarySha256,
  buildGrantAnalysisAttachmentSummary({
    source: "kstartup",
    payload: attachmentPayload,
    attachments: [{
      ...firstAttachment,
      conversion: { ...firstAttachment.conversion, markdown_sha256: "c".repeat(64) },
    }],
  }).attachmentSummarySha256,
  "converted markdown content changes must change the attachment commitment",
);

const declaredMissingRaw = {
  source: "kstartup" as const,
  payload: {
    pbanc_sn: "declared-missing",
    detail: kstartupDetailAttachments(1),
  },
  attachments: [],
};
const declaredMissingSummary = buildGrantAnalysisAttachmentSummary(declaredMissingRaw);
assert.equal(declaredMissingSummary.declaredKnown, true);
assert.equal(declaredMissingSummary.declaredCount, 1);
assert.equal(declaredMissingSummary.presentCount, 0);
assert.equal(declaredMissingSummary.expectedCount, 1);
assert.equal(declaredMissingSummary.inventoryIncomplete, true);
assert.notEqual(
  declaredMissingSummary.attachmentSummarySha256,
  buildGrantAnalysisAttachmentSummary({
    ...declaredMissingRaw,
    payload: { pbanc_sn: "declared-missing", detail: kstartupDetailAttachments(2) },
  }).attachmentSummarySha256,
  "source-declared attachment count must affect the attachment commitment",
);

const bizInfoDeclaredSummary = buildGrantAnalysisAttachmentSummary({
  source: "bizinfo",
  payload: {
    pblancId: "bizinfo-declared",
    fileNm: "declared.pdf",
    flpthNm: "/files/declared.pdf",
  },
  attachments: [],
});
assert.equal(bizInfoDeclaredSummary.declaredKnown, true);
assert.equal(bizInfoDeclaredSummary.declaredCount, 1);
assert.equal(bizInfoDeclaredSummary.inventoryIncomplete, true);

const rawPayloadBefore = { pbanc_sn: "raw-contract", detl_pg_url: "https://before.invalid" };
const rawPayloadAfter = { ...rawPayloadBefore, detl_pg_url: "https://after.invalid" };
const emptyAttachmentSummary = buildGrantAnalysisAttachmentSummary({
  source: "kstartup",
  payload: rawPayloadBefore,
  attachments: [],
});
assert.notEqual(
  buildGrantAnalysisSourceRevision({
    source: "kstartup",
    sourceId: "raw-contract",
    rawPayloadSha256: hashGrantRawPayload(rawPayloadBefore),
    attachmentSummarySha256: emptyAttachmentSummary.attachmentSummarySha256,
  }),
  buildGrantAnalysisSourceRevision({
    source: "kstartup",
    sourceId: "raw-contract",
    rawPayloadSha256: hashGrantRawPayload(rawPayloadAfter),
    attachmentSummarySha256: emptyAttachmentSummary.attachmentSummarySha256,
  }),
  "every API payload mutation must change sourceRevision; only attachment locator/timestamp/error values are excluded",
);

const mismatch = fixtureEntry({
  source: "kstartup",
  sourceId: "raw-hash-mismatch",
  criteriaCount: 0,
  loadableAttachment: false,
});
mismatch.raw.raw_hash = "0".repeat(64);
assert.throws(
  () => selectGrantAnalysisEvaluationCohort({
    entries: [...entries, mismatch],
    duplicateInclusiveEntries: [...entries, mismatch],
    expectedReceipt: fixtureExpectedReceipt(entries.length + 1, 2),
    seed: SEED,
  }),
  /stored raw_hash does not match/,
);

const missingRawHash = fixtureEntry({
  source: "bizinfo",
  sourceId: "raw-hash-missing",
  criteriaCount: 0,
  loadableAttachment: false,
});
delete missingRawHash.raw.raw_hash;
assert.throws(
  () => selectGrantAnalysisEvaluationCohort({
    entries: [...entries, missingRawHash],
    duplicateInclusiveEntries: [...entries, missingRawHash],
    expectedReceipt: fixtureExpectedReceipt(entries.length + 1, 2),
    seed: SEED,
  }),
  /raw_hash must be present as 64 hexadecimal characters/,
);

assert.throws(
  () => selectGrantAnalysisEvaluationCohort({
    entries,
    expectedReceipt: EXPECTED_RECEIPT,
    seed: SEED,
  } as unknown as Parameters<typeof selectGrantAnalysisEvaluationCohort>[0]),
  /duplicate-inclusive population is required/,
);

assert.throws(
  () => selectGrantAnalysisEvaluationCohort({
    entries,
    duplicateInclusiveEntries: entries,
    expectedReceipt: {
      canonicalCount: entries.length,
      duplicateInclusiveCount: entries.length,
      configuredLegacyKeyCount: 12,
    } as GrantAnalysisEvaluationExpectedReceipt,
    seed: SEED,
  }),
  /expected receipt requires excludedCanonicalCount/,
);

const missingLegacyPopulation = entries.filter((entry) => entry.grant.source_id !== "178387");
assert.throws(
  () => selectGrantAnalysisEvaluationCohort({
    entries: missingLegacyPopulation,
    duplicateInclusiveEntries: missingLegacyPopulation,
    expectedReceipt: fixtureExpectedReceipt(missingLegacyPopulation.length, 2),
    seed: SEED,
  }),
  /expected population receipt verification failed/,
);

const infeasible = entries.filter((entry) => entry.grant.source_id !== "kstartup-loadable-4");
assert.throws(
  () => selectGrantAnalysisEvaluationCohort({
    entries: infeasible,
    duplicateInclusiveEntries: infeasible,
    expectedReceipt: fixtureExpectedReceipt(infeasible.length, 2),
    seed: SEED,
  }),
  /Infeasible evaluation cohort quota for kstartup\/sparse_attachment_loadable: need 4, found 3/,
);

const differentSeed = selectGrantAnalysisEvaluationCohort({
  entries,
  duplicateInclusiveEntries: entries,
  expectedReceipt: EXPECTED_RECEIPT,
  seed: "cd".repeat(32),
});
assert.notEqual(
  first.secretManifest.manifestSha256,
  differentSeed.secretManifest.manifestSha256,
  "secret seed must affect rank and opaque commitments",
);

const validationTamper = cloneManifestPair(first);
validationTamper.publicManifest.validation[0]!.title = "tampered public title";
rehashManifest(validationTamper.publicManifest);
validationTamper.secretManifest.publicManifestSha256 = validationTamper.publicManifest.manifestSha256;
rehashManifest(validationTamper.secretManifest);
assert.throws(
  () => verifyGrantAnalysisEvaluationManifestPair(
    validationTamper.publicManifest,
    validationTamper.secretManifest,
    EXPECTED_RECEIPT,
  ),
  /public validation projection verification failed/,
);

const sealedCommitmentTamper = cloneManifestPair(first);
sealedCommitmentTamper.secretManifest.selected
  .find((entry) => entry.split === "sealed")!.opaqueCommitmentSha256 = "0".repeat(64);
rehashManifest(sealedCommitmentTamper.secretManifest);
assert.throws(
  () => verifyGrantAnalysisEvaluationManifestPair(
    sealedCommitmentTamper.publicManifest,
    sealedCommitmentTamper.secretManifest,
    EXPECTED_RECEIPT,
  ),
  /opaque commitment verification failed/,
);

const seedShapeTamper = cloneManifestPair(first);
seedShapeTamper.secretManifest.seed = "not-hex";
rehashManifest(seedShapeTamper.secretManifest);
assert.throws(
  () => verifyGrantAnalysisEvaluationManifestPair(
    seedShapeTamper.publicManifest,
    seedShapeTamper.secretManifest,
    EXPECTED_RECEIPT,
  ),
  /seed must be exactly 64 hexadecimal characters/,
);

console.log("grantAnalysisEvaluationCohort.test.ts: all assertions passed");

function fixtureExpectedReceipt(
  populationCount: number,
  excludedCanonicalCount: number,
): GrantAnalysisEvaluationExpectedReceipt {
  return {
    canonicalCount: populationCount,
    duplicateInclusiveCount: populationCount,
    configuredLegacyKeyCount: 12,
    excludedCanonicalCount,
  };
}

function kstartupDetailAttachments(count: number) {
  return {
    parser_version: "fixture-v1",
    fetched_at: "2026-07-14T00:00:00.000Z",
    apply_method_text: null,
    submit_documents_text: null,
    attachments: Array.from({ length: count }, (_, index) => ({
      filename: `declared-${index + 1}.pdf`,
      url: `https://not-committed.invalid/declared-${index + 1}.pdf`,
    })),
  };
}

function cloneManifestPair(pair: {
  publicManifest: GrantAnalysisEvaluationPublicManifest;
  secretManifest: GrantAnalysisEvaluationSecretManifest;
}): {
  publicManifest: GrantAnalysisEvaluationPublicManifest;
  secretManifest: GrantAnalysisEvaluationSecretManifest;
} {
  return JSON.parse(JSON.stringify(pair)) as {
    publicManifest: GrantAnalysisEvaluationPublicManifest;
    secretManifest: GrantAnalysisEvaluationSecretManifest;
  };
}

function rehashManifest<T extends { manifestSha256: string }>(manifest: T): void {
  const { manifestSha256: _previous, ...payload } = manifest;
  manifest.manifestSha256 = createHash("sha256")
    .update(stableJsonStringify(payload), "utf8")
    .digest("hex");
}

function fixturePopulation(): Array<NormalizedGrant<unknown>> {
  const result: Array<NormalizedGrant<unknown>> = [];
  for (const source of ["kstartup", "bizinfo"] as const) {
    for (let index = 1; index <= 8; index += 1) {
      result.push(fixtureEntry({
        source,
        sourceId: `${source}-unavailable-${index}`,
        criteriaCount: index % 2,
        loadableAttachment: false,
      }));
    }
    for (let index = 1; index <= 4; index += 1) {
      result.push(fixtureEntry({
        source,
        sourceId: `${source}-loadable-${index}`,
        criteriaCount: index % 2,
        loadableAttachment: true,
      }));
      result.push(fixtureEntry({
        source,
        sourceId: `${source}-mid-${index}`,
        criteriaCount: index % 2 === 0 ? 2 : 5,
        loadableAttachment: false,
      }));
      result.push(fixtureEntry({
        source,
        sourceId: `${source}-high-${index}`,
        criteriaCount: index % 2 === 0 ? 6 : 9,
        loadableAttachment: index % 2 === 0,
      }));
    }
  }
  result.push(fixtureEntry({
    source: "kstartup",
    sourceId: "178387",
    criteriaCount: 0,
    loadableAttachment: false,
  }));
  result.push(fixtureEntry({
    source: "bizinfo",
    sourceId: "PBLN_000000000124200",
    criteriaCount: 0,
    loadableAttachment: false,
  }));
  return result;
}

function fixtureEntry(options: {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
  criteriaCount: number;
  loadableAttachment: boolean;
}): NormalizedGrant<unknown> {
  const title = `Fixture ${options.sourceId}`;
  const payload = options.source === "kstartup"
    ? { pbanc_sn: options.sourceId, biz_pbanc_nm: title, fixture: options.sourceId }
    : { pblancId: options.sourceId, pblancNm: title, fixture: options.sourceId };
  const rawHash = hashGrantRawPayload(payload);
  return {
    raw: {
      source: options.source,
      source_id: options.sourceId,
      payload,
      status: "normalized",
      raw_hash: rawHash,
      attachments: options.loadableAttachment ? [loadableAttachment(options.sourceId)] : [],
    },
    grant: {
      id: `canonical-${options.sourceId}`,
      source: options.source,
      source_id: options.sourceId,
      title,
      status: "open",
      apply_start: "2026-07-01",
      apply_end: "2026-08-31",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.5,
    },
    criteria: Array.from({ length: options.criteriaCount }, (_, index) => fixtureCriterion(index)),
  };
}

function loadableAttachment(sourceId: string) {
  return {
    filename: `${sourceId}.pdf`,
    source_uri: `https://not-committed.invalid/source/${sourceId}`,
    storage_key: `grant-analysis/archive/${sourceId}.pdf`,
    content_type: "application/pdf",
    bytes: 1_024,
    sha256: "a".repeat(64),
    fetched_at: "2026-07-14T00:00:00.000Z",
    archive_url: `https://not-committed.invalid/${sourceId}`,
    conversion: {
      status: "converted" as const,
      markdown_url: `https://not-committed.invalid/markdown/${sourceId}`,
      markdown_storage_key: `grant-analysis/markdown/${sourceId}.md`,
      markdown_sha256: "b".repeat(64),
      markdown_bytes: 512,
      converter: "fixture-converter-v1",
      ocr_provider: "fixture-ocr",
      ocr_confidence: 0.9,
      converted_at: "2026-07-14T00:01:00.000Z",
      error: "not committed",
    },
  };
}

function fixtureCriterion(index: number): GrantCriterion {
  return {
    dimension: "region",
    operator: "text_only",
    value: { text: `fixture-${index}` },
    kind: "required",
    confidence: 0.5,
  };
}

function countSelected(
  selected: Array<{ source: GrantAnalysisEvaluationSource; stratum: GrantAnalysisEvaluationStratum; split: GrantAnalysisEvaluationSplit }>,
  source: GrantAnalysisEvaluationSource,
  stratum: GrantAnalysisEvaluationStratum,
  split: GrantAnalysisEvaluationSplit,
): number {
  return selected.filter((entry) =>
    entry.source === source && entry.stratum === stratum && entry.split === split).length;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  GrantCriterion,
  NormalizedGrant,
} from "@cunote/contracts";
import { hashGrantRawPayload, stableJsonStringify } from "../ingestion/grantRawHash";
import {
  DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS,
  DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS,
  DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS,
  selectDeepAnalysisQualityCohort,
  verifyDeepAnalysisQualityManifestPair,
  type DeepAnalysisQualityCohortSelection,
  type DeepAnalysisQualityExpectedReceipt,
} from "./qualityCohort";

const SEED = "ab".repeat(32);
const activeEntries = fixtureActivePopulation(true);
const recoveryEntries = DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS.map((key) => {
  const [source, sourceId] = key.split(":") as ["kstartup" | "bizinfo", string];
  return fixtureEntry({ source, sourceId, includeHwpx: true });
});
const expectedReceipt: DeepAnalysisQualityExpectedReceipt = {
  activeCanonicalCount: activeEntries.length,
  activeDuplicateInclusiveCount: activeEntries.length,
  configuredPreviousEvaluationKeyCount: 12,
  excludedActivePreviousEvaluationCount: 2,
  requiredRecoveryCount: 4,
  historicalRecoveryCount: 3,
};

const first = selectDeepAnalysisQualityCohort({
  activeEntries,
  duplicateInclusiveEntries: [...activeEntries].reverse(),
  requiredRecoveryEntries: recoveryEntries,
  expectedReceipt,
  seed: SEED,
});
const second = selectDeepAnalysisQualityCohort({
  activeEntries: [...activeEntries].reverse(),
  duplicateInclusiveEntries: activeEntries,
  requiredRecoveryEntries: [...recoveryEntries].reverse(),
  expectedReceipt,
  seed: SEED,
});

assert.deepEqual(first, second, "quality cohort selection must ignore repository ordering");
assert.equal(first.secretManifest.selected.length, 80);
assert.equal(first.publicManifest.validation.length, 48);
assert.equal(first.publicManifest.sealed.length, 32);
assert.equal(
  first.secretManifest.selected.filter((entry) => entry.source === "kstartup").length,
  40,
);
assert.equal(
  first.secretManifest.selected.filter((entry) => entry.source === "bizinfo").length,
  40,
);
for (const tag of DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS) {
  assert(
    first.publicManifest.coverageCounts[tag] >= DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS[tag],
    `${tag} coverage must satisfy the frozen target`,
  );
}
for (const key of DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS) {
  assert(
    first.secretManifest.selected.some(
      (entry) => `${entry.source}:${entry.sourceId}` === key && entry.requiredRecovery,
    ),
    `required recovery fixture must be selected: ${key}`,
  );
}
verifyDeepAnalysisQualityManifestPair(
  first.publicManifest,
  first.secretManifest,
  expectedReceipt,
);

const publicJson = JSON.stringify(first.publicManifest);
assert.equal(publicJson.includes(SEED), false, "public manifest must not expose the seed");
for (const sealed of first.secretManifest.selected.filter((entry) => entry.split === "sealed")) {
  assert.equal(
    publicJson.includes(`"sourceId":${JSON.stringify(sealed.sourceId)}`),
    false,
    `public manifest leaked sealed sourceId ${sealed.sourceId}`,
  );
  assert.equal(
    publicJson.includes(`"title":${JSON.stringify(sealed.title)}`),
    false,
    `public manifest leaked sealed title ${sealed.title}`,
  );
}

const tampered = cloneSelection(first);
tampered.secretManifest.selected[0]!.sourceId = "tampered-source-id";
rehashManifest(tampered.secretManifest);
assert.throws(
  () => verifyDeepAnalysisQualityManifestPair(
    tampered.publicManifest,
    tampered.secretManifest,
    expectedReceipt,
  ),
  /selector rank mismatch/,
);

assert.throws(
  () => selectDeepAnalysisQualityCohort({
    activeEntries: fixtureActivePopulation(false),
    duplicateInclusiveEntries: fixtureActivePopulation(false),
    requiredRecoveryEntries: recoveryEntries.map((entry) =>
      fixtureEntry({
        source: entry.grant.source as "kstartup" | "bizinfo",
        sourceId: entry.grant.source_id,
        includeHwpx: false,
      })),
    expectedReceipt,
    seed: SEED,
  }),
  /coverage target is infeasible for hwpx_attachment/,
);

console.log("deep-analysis quality cohort tests passed");

function fixtureActivePopulation(
  includeHwpx: boolean,
): Array<NormalizedGrant<unknown>> {
  const entries: Array<NormalizedGrant<unknown>> = [];
  for (const source of ["kstartup", "bizinfo"] as const) {
    for (let index = 1; index <= 50; index += 1) {
      entries.push(fixtureEntry({
        source,
        sourceId: `${source}-quality-${index}`,
        includeHwpx,
      }));
    }
  }
  entries.push(fixtureEntry({
    source: "kstartup",
    sourceId: "178387",
    includeHwpx,
  }));
  entries.push(fixtureEntry({
    source: "bizinfo",
    sourceId: "PBLN_000000000124200",
    includeHwpx,
  }));
  entries.push(fixtureEntry({
    source: "bizinfo",
    sourceId: "PBLN_000000000121478",
    includeHwpx,
  }));
  return entries;
}

function fixtureEntry(input: {
  source: "kstartup" | "bizinfo";
  sourceId: string;
  includeHwpx: boolean;
}): NormalizedGrant<unknown> {
  const title = `통합 공고 Fixture ${input.sourceId}`;
  const payload = input.source === "kstartup"
    ? { pbanc_sn: input.sourceId, biz_pbanc_nm: title, detail: null }
    : { pblancId: input.sourceId, pblancNm: title };
  return {
    raw: {
      source: input.source,
      source_id: input.sourceId,
      payload,
      raw_hash: hashGrantRawPayload(payload),
      status: "normalized",
      attachments: [
        loadableAttachment(`${input.sourceId}-one.hwp`, 24_000),
        ...(input.includeHwpx
          ? [loadableAttachment(`${input.sourceId}-two.hwpx`, 8_000)]
          : []),
        loadableAttachment(`${input.sourceId}-three.pdf`, 8_000),
      ],
    },
    grant: {
      id: `canonical-${input.source}-${input.sourceId}`,
      source: input.source,
      source_id: input.sourceId,
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
    criteria: [exclusionCriterion()],
  };
}

function loadableAttachment(filename: string, markdownBytes: number) {
  const slug = filename.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    filename,
    source_uri: `https://fixture.invalid/source/${slug}`,
    storage_key: `deep-analysis/quality/archive/${slug}`,
    content_type: "application/octet-stream",
    bytes: 1_024,
    sha256: "a".repeat(64),
    archive_url: `https://fixture.invalid/archive/${slug}`,
    conversion: {
      status: "converted" as const,
      markdown_url: `https://fixture.invalid/markdown/${slug}`,
      markdown_storage_key: `deep-analysis/quality/markdown/${slug}.md`,
      markdown_sha256: "b".repeat(64),
      markdown_bytes: markdownBytes,
      converter: "fixture-v1",
      ocr_provider: null,
      ocr_confidence: null,
    },
  };
}

function exclusionCriterion(): GrantCriterion {
  return {
    dimension: "industry",
    operator: "not_in",
    value: { tags: ["fixture"] },
    kind: "exclusion",
    confidence: 0.8,
  };
}

function cloneSelection(
  selection: DeepAnalysisQualityCohortSelection,
): DeepAnalysisQualityCohortSelection {
  return JSON.parse(JSON.stringify(selection)) as DeepAnalysisQualityCohortSelection;
}

function rehashManifest<T extends { manifestSha256: string }>(manifest: T): void {
  const { manifestSha256: _manifestSha256, ...payload } = manifest;
  manifest.manifestSha256 = createHash("sha256")
    .update(stableJsonStringify(payload))
    .digest("hex");
}

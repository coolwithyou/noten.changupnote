import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLegacyMaterialHistories, verifyLegacySourceChange } from "./legacy-material-history";
import { classifyMatchingInventorySnapshot, type MatchingInventoryHistory } from "./matching-inventory-campaign";

const id = "00000000-0000-4000-8000-000000000001";
const sha = (c: string) => c.repeat(64);
function classify(history: MatchingInventoryHistory, inputSha256 = sha("a")) {
  return classifyMatchingInventorySnapshot({ observedAt: "2026-09-25T00:00:00.000Z", targets: [{
    grantId: id, inputSha256, attachmentManifestSha256: sha("b"), closesToday: false,
    eligibility: { eligible: true }, history,
  }] }).entries[0]!;
}

test("legacy bytes prove changed input only; unchanged and contract-only changes remain held", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-legacy-material-"));
  try {
    assert.equal((await readLegacyMaterialHistories(root, new Set())).size, 0);
    const dir = join(root, "spike-out", "analysis-lab", "bizinfo__sample");
    await mkdir(dir, { recursive: true });
    const run = { grantId: id, source: "bizinfo", sourceId: "sample", runId: "run-20260925-test",
      startedAt: "2026-09-25T00:00:00.000Z", inputSha256: sha("a"), attachmentManifestSha256: sha("b") };
    const path = join(dir, `${run.runId}.json`);
    await writeFile(path, JSON.stringify(run));
    // A newer malformed or mismatched file cannot replace verified material.
    await writeFile(join(dir, "run-newer.json"), JSON.stringify({ ...run, startedAt: "2026-09-26T00:00:00.000Z" }));
    const history = (await readLegacyMaterialHistories(root, new Set([id]))).get(id)!;
    assert.equal(history.kind, "legacy_material");
    assert.equal(classify(history).campaignEligible, false);
    assert.equal(classify(history).nextAction, "review_existing_analysis");
    const changed = classify(history, sha("c"));
    assert.equal(changed.category, "source_changed");
    assert.equal(changed.campaignEligible, true);
    await verifyLegacySourceChange(root, changed);
    await assert.rejects(verifyLegacySourceChange(root, classify(history)), /unchanged legacy/);
    await assert.rejects(verifyLegacySourceChange(root, { ...changed, grantId: "00000000-0000-4000-8000-000000000002" }), /bytes changed/);
    await writeFile(path, JSON.stringify({ ...run, inputSha256: sha("d") }));
    await assert.rejects(verifyLegacySourceChange(root, changed), /bytes changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unbound history and source recovery never become automatic execution candidates", () => {
  assert.equal(classify({ kind: "legacy", evidence: "deep_repair_history" }, sha("c")).campaignEligible, false);
  const history = { kind: "legacy_material", source: "bizinfo", sourceId: "sample", runId: "run-test",
    inputSha256: sha("a"), attachmentManifestSha256: sha("b"), contractCompatible: false,
    sourceRunArtifactSha256: sha("d") } as const;
  const result = classifyMatchingInventorySnapshot({ observedAt: "2026-09-25T00:00:00.000Z", targets: [{
    grantId: id, inputSha256: sha("c"), attachmentManifestSha256: sha("b"), closesToday: false,
    eligibility: { eligible: true }, readinessNextWork: "source_recovery", history,
  }] });
  assert.equal(result.entries[0]!.campaignEligible, false);
  assert.equal(result.entries[0]!.nextAction, "recover_source");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeepRepairHistoricalGrantIds, validateHistoricalCurrentLaunchInventory } from "./deep-repair-preparation-history";
import { validateCurrentLaunchInventory } from "./current-inventory-launch";
const hash = "a".repeat(64);
const grantId = "76069674-e762-456e-9c69-9c94e76eba1f";
const prior = { grantId, priorSequence: 18, priorRunId: "run-2026-09-25T033757.034Z-c6f4e3", priorSourceRevisionSha256: hash, priorInputSha256: hash, priorAttachmentManifestSha256: hash };
const target = { sequence: 0, grantId, stratum: "kstartup/medium", inputSha256: hash, attachmentManifestSha256: hash, sourceRevisionSha256: hash, matchingMaterialSourceBinding: { schema: "analysis-matching-material-source-binding-v1", materialSourceRevisionSha256: hash, sourceRawSha256: hash } };
const inventory = { schema: "analysis-current-inventory-v1", seriesId: "current-artifact-loss-20260925", observedAt: "2026-09-25T09:18:29.074Z", model: "claude-opus-4-8", policy: "open-visible-current-period-artifact-loss-reanalysis-v1", historicalGrantIdsSha256: hash, artifactLossRecovery: { schema: "analysis-artifact-loss-reanalysis-attestation-v1", evidenceStatus: "session-transcript-only", sessionTranscriptSha256: hash, priorManifestSha256: hash, priorGrantSha256: hash, priorTerminalReceiptSha256: hash, targets: [prior] }, targets: [target] };
assert.deepEqual(validateHistoricalCurrentLaunchInventory(inventory).targets.map(t => t.grantId), [grantId]);
assert.throws(() => validateCurrentLaunchInventory(inventory), /계약/, "history-only compatibility does not grant current launch admission");
for (const mutated of [
  { ...inventory, policy: "unknown-policy" },
  { ...inventory, seriesId: "current-unseen-v1" },
  { ...inventory, targets: [{ ...target, inputSha256: "b".repeat(64) }] },
  { ...inventory, targets: [{ ...target, sourceRevisionSha256: "b".repeat(64) }] },
  { ...inventory, targets: [{ ...target, attachmentManifestSha256: "b".repeat(64) }] },
  { ...inventory, targets: [{ ...target, sequence: 2 }] },
  { ...inventory, targets: [{ ...target, matchingMaterialSourceBinding: undefined }] },
  { ...inventory, targets: [{ ...target, matchingMaterialSourceBinding: { ...target.matchingMaterialSourceBinding, sourceRawSha256: "bad" } }] },
  { ...inventory, artifactLossRecovery: undefined },
  { ...inventory, artifactLossRecovery: { ...inventory.artifactLossRecovery, priorGrantSha256: "bad" } },
  { ...inventory, artifactLossRecovery: { ...inventory.artifactLossRecovery, targets: [{ ...prior, priorRunId: "bad" }] } },
  { ...inventory, artifactLossRecovery: { ...inventory.artifactLossRecovery, targets: [{ ...prior, grantId: "13892d8b-a06b-4717-aeda-da44772a786c" }] } },
  { ...inventory, targets: [target, { ...target, sequence: 1 }] },
  { ...inventory, targets: [target, { ...target, sequence: 1, grantId: "13892d8b-a06b-4717-aeda-da44772a786c" }], artifactLossRecovery: { ...inventory.artifactLossRecovery, targets: [prior, { ...prior, grantId: "13892d8b-a06b-4717-aeda-da44772a786c" }] } },
]) assert.throws(() => validateHistoricalCurrentLaunchInventory(mutated));
const root = await mkdtemp(join(tmpdir(), "cunote-history-loss-"));
try {
  const dir = join(root, "launch", "inventories"); await mkdir(dir, { recursive: true });
  await writeFile(join(root, "cohort.json"), JSON.stringify({ grantIds: ["00000000-0000-4000-8000-000000000001"] }));
  const bytes = Buffer.from(JSON.stringify(inventory)); const name = `${createHash("sha256").update(bytes).digest("hex")}.json`;
  await writeFile(join(dir, name), bytes);
  assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir: root, scope: "all" }), ["00000000-0000-4000-8000-000000000001", grantId], "known recovery inventory adds every target to unchanged all-history exclusion");
  assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir: root, scope: "formal-baseline" }), [], "formal-baseline semantics remain unchanged");
  await writeFile(join(dir, name), `${bytes.toString()} `);
  await assert.rejects(readDeepRepairHistoricalGrantIds({ rootDir: root }), /SHA mismatch/, "tampered committed bytes remain fail closed");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("historical artifact loss inventory: producer contract, exact material, unchanged exclusion and tamper rejection passed");

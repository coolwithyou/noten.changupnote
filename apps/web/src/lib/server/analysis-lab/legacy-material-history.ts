import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MatchingInventoryClassificationEntry, MatchingInventoryHistory } from "./matching-inventory-campaign";

const SHA = /^[a-f0-9]{64}$/u;
type Material = Extract<MatchingInventoryHistory, { kind: "legacy_material" }>;

/** Historical bytes establish input identity only. No review/receipt/permission is
 * inferred. An unchanged legacy run still requires review rather than a new call. */
export async function readLegacyMaterialHistories(root: string, grantIds: ReadonlySet<string>): Promise<Map<string, Material>> {
  const directory = join(root, "spike-out", "analysis-lab");
  const result = new Map<string, Material>();
  if (!grantIds.size) return result;
  const dates = new Map<string, string>();
  for (const dir of await readdir(directory, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^(bizinfo|kstartup)__[A-Za-z0-9_.-]+$/u.test(dir.name)) continue;
    for (const filename of await readdir(join(directory, dir.name))) {
      if (!/^run-[A-Za-z0-9_.-]+\.json$/u.test(filename)) continue;
      const bytes = await readFile(join(directory, dir.name, filename));
      let run;
      try { run = JSON.parse(bytes.toString("utf8")); } catch { continue; }
      if (!grantIds.has(run.grantId) || filename !== `${run.runId}.json`
          || dir.name !== `${run.source}__${run.sourceId}`
          || !SHA.test(run.inputSha256 ?? "") || !SHA.test(run.attachmentManifestSha256 ?? "")
          || !Number.isFinite(Date.parse(run.startedAt))) continue;
      const order = `${run.startedAt}:${run.runId}`;
      if ((dates.get(run.grantId) ?? "") >= order) continue;
      dates.set(run.grantId, order);
      result.set(run.grantId, {
        kind: "legacy_material", source: run.source, sourceId: run.sourceId, runId: run.runId,
        inputSha256: run.inputSha256, attachmentManifestSha256: run.attachmentManifestSha256,
        contractCompatible: false, sourceRunArtifactSha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return result;
}

/** Re-read the exact prior run at manifest preparation, not a caller's claim. */
export async function verifyLegacySourceChange(root: string, entry: MatchingInventoryClassificationEntry): Promise<void> {
  if (entry.history.kind !== "legacy_material") return;
  const legacy = entry.history.legacyRun;
  if (!legacy || !/^(bizinfo|kstartup)$/u.test(legacy.source)
      || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(legacy.sourceId)
      || !/^run-[A-Za-z0-9_.-]+$/u.test(legacy.runId) || !SHA.test(legacy.sha256)) throw new Error("legacy material binding missing");
  const bytes = await readFile(join(root, "spike-out", "analysis-lab", `${legacy.source}__${legacy.sourceId}`, `${legacy.runId}.json`));
  const run = JSON.parse(bytes.toString("utf8"));
  if (createHash("sha256").update(bytes).digest("hex") !== legacy.sha256
      || run.grantId !== entry.grantId || run.source !== legacy.source || run.sourceId !== legacy.sourceId || run.runId !== legacy.runId
      || run.inputSha256 !== entry.history.inputSha256 || run.attachmentManifestSha256 !== entry.history.attachmentManifestSha256)
    throw new Error("legacy material bytes changed");
  if (run.inputSha256 === entry.current.inputSha256 && run.attachmentManifestSha256 === entry.current.attachmentManifestSha256)
    throw new Error("unchanged legacy input cannot authorize new analysis preparation");
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeCunoteDb } from "../apps/web/src/lib/server/db/client";
import { loadAnalysisLabEnv } from "../apps/web/src/lib/server/loadMonorepoEnv";
import { prepareArtifactLossRecoveryLaunch } from "../apps/web/src/lib/server/analysis-lab/current-inventory-launch-production";
import { findMonorepoRoot } from "../apps/web/src/lib/server/analysis-lab/run-store";
import type { ArtifactLossRecoveryAttestation } from "../apps/web/src/lib/server/analysis-lab/current-inventory-launch";

const path = join(findMonorepoRoot(), "docs", "evidence", "2026-09-25-clean3-artifact-loss-attestation.json");
const attestation = JSON.parse(await readFile(path, "utf8")) as ArtifactLossRecoveryAttestation;
loadAnalysisLabEnv();
try {
  const result = await prepareArtifactLossRecoveryLaunch({ attestation, concurrency: 2 });
  console.log(JSON.stringify({
    kind: "artifact-loss-reanalysis-manifest",
    manifestSha256: result.manifestSha256,
    manifestPath: result.path,
    inventorySha256: result.inventorySha256,
    inventoryPath: result.inventoryPath,
    targetCount: result.manifest.targets.length,
    model: result.manifest.execution.model,
    analysisMode: result.manifest.execution.analysisMode,
    existingRunPolicy: result.manifest.execution.existingRunPolicy,
    liveExecutionAuthorized: result.liveExecutionAuthorized,
    modelCalls: result.modelCalls,
    serviceWrites: result.serviceWrites,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

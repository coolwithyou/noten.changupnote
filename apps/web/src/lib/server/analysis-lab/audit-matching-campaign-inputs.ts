/** Read-only physical input and attachment coverage audit for a sealed matching campaign. */
import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { prepareLabAnalysis } from "./analyze";
import { normalizeAnalysisLaunchManifest, readAnalysisLaunchArtifact } from "./launch-batch-artifacts";
import { readMatchingCampaignIndex } from "./matching-inventory-campaign";
import { findMonorepoRoot } from "./run-store";

const SHA = /^[a-f0-9]{64}$/u;

export async function auditMatchingCampaignInputs(campaignSha256: string) {
  if (!SHA.test(campaignSha256)) throw new Error("--campaign requires a SHA-256 digest");
  const root = findMonorepoRoot();
  const campaign = await readMatchingCampaignIndex(root, campaignSha256);
  const targets = [];
  const seen = new Set<string>();
  for (const child of campaign.children) {
    const manifest = normalizeAnalysisLaunchManifest(
      await readAnalysisLaunchArtifact("manifests", child.manifestSha256, root),
    );
    if (manifest.execution.analysisMode !== "matching_only"
      || manifest.targets.length !== child.targetCount
      || manifest.targets.some((target, index) => target.grantId !== child.targetGrantIds[index])) {
      throw new Error(`campaign child target binding mismatch: ${child.manifestSha256}`);
    }
    for (const target of manifest.targets) {
      if (seen.has(target.grantId)) throw new Error(`duplicate campaign target: ${target.grantId}`);
      seen.add(target.grantId);
      targets.push({ ...target, childManifestSha256: child.manifestSha256 });
    }
  }
  if (targets.length !== campaign.children.reduce((count, child) => count + child.targetCount, 0)) {
    throw new Error("campaign target count mismatch");
  }

  const results = [];
  for (let offset = 0; offset < targets.length; offset += 2) {
    const batch = await Promise.all(targets.slice(offset, offset + 2).map(async (target) => {
      const prepared = await prepareLabAnalysis(target.grantId);
      if (prepared.grant.id !== target.grantId) throw new Error("prepared grant ID mismatch");
      const missing = (prepared.input.attachmentPreparationReport ?? [])
        .filter((attachment) => attachment.inputOutcome !== "loaded"
          && attachment.inputOutcome !== "covered_by_children")
        .map((attachment) => ({
          filename: attachment.filename,
          documentRole: attachment.documentRole,
          inputOutcome: attachment.inputOutcome,
          missingReason: attachment.missingReason,
          recoveryMode: attachment.recovery.mode,
        }));
      return {
        grantId: target.grantId,
        source: prepared.grant.source,
        sourceId: prepared.grant.sourceId,
        childManifestSha256: target.childManifestSha256,
        manifestInputSha256: target.inputSha256,
        currentInputSha256: prepared.input.inputSha256,
        manifestAttachmentSha256: target.attachmentManifestSha256,
        currentAttachmentSha256: prepared.input.attachmentManifestSha256,
        materialMatches: target.inputSha256 === prepared.input.inputSha256
          && target.attachmentManifestSha256 === prepared.input.attachmentManifestSha256,
        missing,
      };
    }));
    results.push(...batch);
  }
  const materialDrift = results.filter((target) => !target.materialMatches);
  const missing = results.flatMap((target) => target.missing.map((attachment) => ({
    grantId: target.grantId, source: target.source, sourceId: target.sourceId, ...attachment,
  })));
  const missingAnnouncements = missing.filter((attachment) =>
    attachment.documentRole === "announcement");
  return {
    schema: "matching-campaign-physical-input-audit-v1" as const,
    generatedAt: new Date().toISOString(),
    campaignSha256,
    targetCount: targets.length,
    materialDriftCount: materialDrift.length,
    materialDriftGrantIds: materialDrift.map((target) => target.grantId),
    missingAttachmentCount: missing.length,
    missingTargetCount: new Set(missing.map((attachment) => attachment.grantId)).size,
    missingAnnouncementCount: missingAnnouncements.length,
    missingAnnouncementTargetCount: new Set(missingAnnouncements.map((attachment) => attachment.grantId)).size,
    missing,
    targets: results,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const campaign = args.find((arg) => arg.startsWith("--campaign="))?.slice("--campaign=".length);
  const requireAnnouncementCoverage = args.includes("--require-announcement-coverage");
  if (!campaign || args.length !== (requireAnnouncementCoverage ? 2 : 1)) {
    throw new Error("usage: --campaign=<sha256> [--require-announcement-coverage]");
  }
  loadAnalysisLabEnv();
  try {
    const report = await auditMatchingCampaignInputs(campaign);
    console.log(JSON.stringify(report, null, 2));
    if (report.materialDriftCount > 0
      || requireAnnouncementCoverage && report.missingAnnouncementCount > 0) {
      process.exitCode = 2;
    }
  } finally { await closeCunoteDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

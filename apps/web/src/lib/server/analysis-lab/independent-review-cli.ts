import { resolve } from "node:path";
import {
  aggregateIndependentReviews,
  prepareIndependentReviewPackets,
  validateAndWrapIndependentReviewResult,
  writeIndependentReviewResult,
} from "./independent-review-packet";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseSequences(value: string | null): number[] | undefined {
  if (value === null) return undefined;
  if (!/^\d+(,\d+)*$/u.test(value)) {
    throw new Error("--sequences는 0 이상의 정수를 쉼표로 구분해야 합니다.");
  }
  return value.split(",").map((item) => Number.parseInt(item, 10));
}

async function main() {
  const aggregateManifest = option("aggregate-manifest");
  if (aggregateManifest) {
    const aggregated = await aggregateIndependentReviews(aggregateManifest);
    console.log(JSON.stringify({
      aggregateSha256: aggregated.aggregateSha256,
      aggregatePath: aggregated.aggregatePath,
      reviewedTargets: aggregated.aggregate.reviewedTargets,
      heldTargets: aggregated.aggregate.heldTargets,
    }, null, 2));
    return;
  }
  const launchReceipt = option("launch-receipt");
  if (launchReceipt) {
    const sequences = parseSequences(option("sequences"));
    const selectionReason = option("selection-reason");
    const prepared = await prepareIndependentReviewPackets(launchReceipt, {
      ...(sequences === undefined ? {} : { sequences }),
      ...(selectionReason === null ? {} : { selectionReason }),
    });
    console.log(JSON.stringify({
      manifestSha256: prepared.manifestSha256,
      manifestPath: prepared.manifestPath,
      outputDir: prepared.outputDir,
      publishableTargets: prepared.manifest.packets.length,
      heldTargets: prepared.manifest.heldTargets.length,
    }, null, 2));
    return;
  }

  const packetPath = option("packet");
  const rawResultPath = option("raw-result");
  const reviewer = option("reviewer");
  const reviewerModel = option("reviewer-model");
  const outputPath = option("output");
  if (!packetPath || !rawResultPath || !outputPath || !reviewerModel || reviewer !== "codex") {
    throw new Error("--launch-receipt, --aggregate-manifest 또는 --packet/--raw-result/--reviewer=codex/--reviewer-model/--output 조합이 필요합니다.");
  }
  const result = await validateAndWrapIndependentReviewResult({
    packetPath: resolve(packetPath),
    rawResultPath: resolve(rawResultPath),
    reviewer,
    reviewerModel,
    reviewerTransport: "codex-cli",
  });
  await writeIndependentReviewResult(resolve(outputPath), result);
  console.log(JSON.stringify({ outputPath: resolve(outputPath), sequence: result.sequence, reviewer: result.reviewer }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

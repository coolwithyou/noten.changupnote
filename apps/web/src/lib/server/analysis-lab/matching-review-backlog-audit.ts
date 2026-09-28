/** 봉인된 현행 분류의 조건 검수 대기 이력을 현재 입력과 읽기 전용으로 대조한다. */
import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { prepareLabAnalysis } from "./analyze";
import { readMatchingInventoryClassification } from "./matching-inventory-campaign";
import { readVerifiedCurrentLaunchHistory } from "./matching-inventory-campaign-production";
import { findMonorepoRoot } from "./run-store";

const SHA = /^[a-f0-9]{64}$/u;

export async function auditMatchingReviewBacklog(classificationSha256: string) {
  if (!SHA.test(classificationSha256)) throw new Error("classification SHA-256이 잘못됐습니다.");
  const root = findMonorepoRoot();
  const classification = await readMatchingInventoryClassification(root, classificationSha256);
  const pending = classification.entries.filter((entry) => entry.nextAction === "review_current_conditions");
  const history = await readVerifiedCurrentLaunchHistory(root, pending.map((entry) => ({
    grantId: entry.grantId,
    closesToday: entry.closesToday,
  })));
  const counts: Record<string, number> = {};
  const targets = [];
  for (let offset = 0; offset < pending.length; offset += 2) {
    const batch = await Promise.all(pending.slice(offset, offset + 2).map(async (entry) => {
      const verified = history.get(entry.grantId)?.history;
      if (!verified) {
        return { grantId: entry.grantId, historyKind: "none", review: null, material: "not_applicable" } as const;
      }
      if (verified.kind !== "primary") {
        return {
          grantId: entry.grantId,
          historyKind: verified.kind,
          review: null,
          material: "not_applicable",
        } as const;
      }
      try {
        const prepared = await prepareLabAnalysis(entry.grantId);
        if (prepared.grant.id !== entry.grantId) throw new Error("prepared grant ID 결속이 다릅니다.");
        return {
          grantId: entry.grantId,
          source: prepared.grant.source,
          sourceId: prepared.grant.sourceId,
          historyKind: "primary",
          review: verified.review,
          material: verified.inputSha256 === prepared.input.inputSha256
            && verified.attachmentManifestSha256 === prepared.input.attachmentManifestSha256
            ? "same" : "changed",
          historicalInputSha256: verified.inputSha256,
          currentInputSha256: prepared.input.inputSha256,
          historicalAttachmentSha256: verified.attachmentManifestSha256,
          currentAttachmentSha256: prepared.input.attachmentManifestSha256,
        } as const;
      } catch (error) {
        return {
          grantId: entry.grantId,
          historyKind: "primary",
          review: verified.review,
          material: "error",
          error: error instanceof Error ? error.message : String(error),
        } as const;
      }
    }));
    for (const target of batch) {
      targets.push(target);
      const key = target.historyKind === "primary"
        ? `primary:${target.review}:${target.material}` : target.historyKind;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  if (targets.length !== pending.length) throw new Error("조건 검수 감사 대상 수가 다릅니다.");
  return {
    schema: "matching-review-backlog-audit-v1" as const,
    classificationSha256,
    classificationObservedAt: classification.observedAt,
    auditedAt: new Date().toISOString(),
    targetCount: targets.length,
    counts,
    targets,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const classificationSha256 = args.length === 1 && args[0]?.startsWith("--classification=")
    ? args[0].slice("--classification=".length) : "";
  if (!SHA.test(classificationSha256)) {
    throw new Error("usage: --classification=<sha256>");
  }
  loadAnalysisLabEnv();
  try {
    const report = await auditMatchingReviewBacklog(classificationSha256);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.targets.some((target) => target.material === "error")) process.exitCode = 2;
  } finally {
    await closeCunoteDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

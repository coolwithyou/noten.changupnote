import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import {
  prepareMatchingInventoryCampaign,
  readMatchingCampaignResumeStatus,
} from "./matching-inventory-campaign-production";

const SHA = /^[a-f0-9]{64}$/u;
const USAGE = `pnpm lab:matching-campaign -- --prepare --as-of=<ISO> --allowed-stage=prepare|grant|launch
pnpm lab:matching-campaign -- --status --campaign=<sha256>`;

export type MatchingCampaignCliArgs =
  | { readonly kind: "prepare"; readonly asOf: Date; readonly allowedStage: "prepare" | "grant" | "launch" }
  | { readonly kind: "status"; readonly campaignSha256: string };

export function parseMatchingCampaignArgs(argv: readonly string[]): MatchingCampaignCliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const mode = args.includes("--prepare") ? "prepare" : args.includes("--status") ? "status" : null;
  if (!mode || (args.includes("--prepare") && args.includes("--status"))) throw new Error(USAGE);
  const values = new Map<string, string>();
  for (const arg of args.filter((value) => value !== "--prepare" && value !== "--status")) {
    const match = /^--(as-of|allowed-stage|campaign)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error(USAGE);
    values.set(match[1]!, match[2]!);
  }
  if (mode === "status") {
    const campaignSha256 = values.get("campaign") ?? "";
    if (values.size !== 1 || !SHA.test(campaignSha256)) throw new Error(USAGE);
    return { kind: "status", campaignSha256 };
  }
  const asOfText = values.get("as-of") ?? "";
  const asOf = new Date(asOfText);
  const allowedStage = values.get("allowed-stage");
  if (values.size !== 2 || !Number.isFinite(asOf.getTime()) || asOf.toISOString() !== asOfText
    || (allowedStage !== "prepare" && allowedStage !== "grant" && allowedStage !== "launch")) {
    throw new Error(USAGE);
  }
  return { kind: "prepare", asOf, allowedStage };
}

async function main() {
  const args = parseMatchingCampaignArgs(process.argv.slice(2));
  loadAnalysisLabEnv();
  try {
    if (args.kind === "prepare") {
      const result = await prepareMatchingInventoryCampaign(args);
      console.log(JSON.stringify({
        campaignSha256: result.campaignSha256,
        campaignPath: result.campaignPath,
        classificationSha256: result.classificationSha256,
        classificationPath: result.classificationPath,
        targetCount: result.classification.targetCount,
        counts: result.classification.counts,
        children: result.index.children.map((child) => ({
          sequence: child.sequence,
          manifestSha256: child.manifestSha256,
          targetCount: child.targetGrantIds.length,
          classifications: child.classifications,
        })),
        allowedStage: result.index.execution.allowedStage,
        liveExecutionAuthorized: false,
        next: "사용자 exact 전체 범위 승인 뒤 각 child에 기존 lab:launch:grant와 lab:launch를 순차 사용",
      }, null, 2));
      return;
    }
    const status = await readMatchingCampaignResumeStatus({ campaignSha256: args.campaignSha256 });
    console.log(JSON.stringify({
      selection: status.selection,
      existingGrantSha256s: status.grantSha256s,
      liveExecutionAuthorized: false,
      next: status.selection.status === "resume_child"
        ? `child manifest ${status.selection.childManifestSha256}에 기존 grant/launch 경로를 사용`
        : "campaign terminal receipts 확인 완료",
    }, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

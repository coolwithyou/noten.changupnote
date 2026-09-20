import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import {
  prepareMatchingInventoryCampaign,
  readMatchingCampaignRunNextPlan,
  readMatchingCampaignResumeStatus,
} from "./matching-inventory-campaign-production";

const SHA = /^[a-f0-9]{64}$/u;
const USAGE = `pnpm lab:matching-campaign -- --prepare --as-of=<ISO> --allowed-stage=prepare|grant|launch [--child-size=1..100]
pnpm lab:matching-campaign -- --status --campaign=<sha256>
pnpm lab:matching-campaign -- --run-next --campaign=<sha256> --child=<sha256> --approved-by=<actor>`;

export type MatchingCampaignCliArgs =
  | {
      readonly kind: "prepare";
      readonly asOf: Date;
      readonly allowedStage: "prepare" | "grant" | "launch";
      readonly childSize: number;
    }
  | { readonly kind: "status"; readonly campaignSha256: string }
  | {
      readonly kind: "run-next";
      readonly campaignSha256: string;
      readonly expectedChildManifestSha256: string;
      readonly approvedBy: string;
    };

export function parseMatchingCampaignArgs(argv: readonly string[]): MatchingCampaignCliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const modes = ["--prepare", "--status", "--run-next"].filter((flag) => args.includes(flag));
  if (modes.length !== 1) throw new Error(USAGE);
  const mode = modes[0]!.slice(2) as "prepare" | "status" | "run-next";
  const values = new Map<string, string>();
  for (const arg of args.filter((value) => !modes.includes(value))) {
    const match = /^--(as-of|allowed-stage|child-size|campaign|child|approved-by)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error(USAGE);
    values.set(match[1]!, match[2]!);
  }
  if (mode === "status") {
    const campaignSha256 = values.get("campaign") ?? "";
    if (values.size !== 1 || !SHA.test(campaignSha256)) throw new Error(USAGE);
    return { kind: "status", campaignSha256 };
  }
  if (mode === "run-next") {
    const campaignSha256 = values.get("campaign") ?? "";
    const expectedChildManifestSha256 = values.get("child") ?? "";
    const approvedBy = values.get("approved-by") ?? "";
    if (values.size !== 3
      || !SHA.test(campaignSha256)
      || !SHA.test(expectedChildManifestSha256)
      || !approvedBy.trim()) throw new Error(USAGE);
    return { kind: "run-next", campaignSha256, expectedChildManifestSha256, approvedBy };
  }
  const asOfText = values.get("as-of") ?? "";
  const asOf = new Date(asOfText);
  const allowedStage = values.get("allowed-stage");
  const childSize = Number(values.get("child-size") ?? "100");
  if ([...values.keys()].some((key) => !["as-of", "allowed-stage", "child-size"].includes(key))
    || (values.size !== 2 && values.size !== 3)
    || !Number.isFinite(asOf.getTime()) || asOf.toISOString() !== asOfText
    || !Number.isInteger(childSize) || childSize < 1 || childSize > 100
    || (allowedStage !== "prepare" && allowedStage !== "grant" && allowedStage !== "launch")) {
    throw new Error(USAGE);
  }
  return { kind: "prepare", asOf, allowedStage, childSize };
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
          targetCount: child.targetCount,
          classifications: child.classifications,
        })),
        childSize: result.index.execution.childSize,
        allowedStage: result.index.execution.allowedStage,
        liveExecutionAuthorized: false,
        next: "사용자 exact 전체 범위 승인 뒤 각 child에 기존 lab:launch:grant와 lab:launch를 순차 사용",
      }, null, 2));
      return;
    }
    if (args.kind === "run-next") {
      const plan = await readMatchingCampaignRunNextPlan(args);
      console.log(JSON.stringify({
        kind: "matching-campaign-run-next-command-plan",
        ...plan,
        liveExecutionAuthorized: false,
        modelCalls: 0,
        serviceWrites: 0,
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

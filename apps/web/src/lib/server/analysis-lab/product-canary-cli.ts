import { readFile } from "node:fs/promises";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import type { ProductCanaryEvidence } from "./product-canary-evidence";

interface VerificationArtifact {
  schema: "analysis-lab-promotion-verification-v1";
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  scope: "canary" | "all";
  issues: unknown[];
  verdict: "PASS" | "FAIL";
}

interface ShadowArtifact {
  schema: "analysis-lab-promotion-shadow-v1";
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  companyCount: number;
  grants: Array<{ grantId: string }>;
  sourceDrift: unknown[];
  baselineDrift: unknown[];
  guardIssues: unknown[];
  verdict: "PASS" | "FAIL";
}

interface Options {
  releaseId: string;
  grantId: string;
  reviewerEmail: string;
}

loadAnalysisLabEnv();
process.env.CUNOTE_REPOSITORY_ADAPTER = "drizzle";

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const [
    { buildGrantSimulationCompanyProfile, GRANT_SIMULATION_BUSINESS_NUMBER },
    { loadServiceApplySheet },
    { loadAdminGrantWorkspaceData },
    {
      buildProductCanaryId,
      evaluateProductCanaryObservation,
      PRODUCT_CANARY_EVIDENCE_SCHEMA,
      writeProductCanaryEvidence,
    },
    { promotionReleaseArtifactPath, readPromotionReleaseManifest },
    { readLabRun },
  ] = await Promise.all([
    import("../adminGrantSimulationProfile"),
    import("../serviceData"),
    import("../documents/workspaceData"),
    import("./product-canary-evidence"),
    import("./promotion-release"),
    import("./run-store"),
  ]);
  const manifest = await readPromotionReleaseManifest(options.releaseId);
  const plan = manifest.plans.find((item) => item.grantId === options.grantId);
  const source = manifest.sourceArtifacts.find((item) => item.grantId === options.grantId);
  if (!plan || !source) throw new Error("release manifest에서 대상 공고를 찾지 못했습니다.");
  if (!manifest.canaryGrantIds.includes(options.grantId)) {
    throw new Error("대상 공고는 이 release의 canary가 아닙니다.");
  }
  if (!source.localLabEvidence || source.runId.length === 0) {
    throw new Error("검증된 로컬 구독 분석 provenance가 없습니다.");
  }
  const run = await readLabRun(options.grantId, source.runId);
  if (!run || run.runId !== source.runId) throw new Error("manifest의 원본 LabRun을 찾지 못했습니다.");

  const [verification, shadow] = await Promise.all([
    readArtifact<VerificationArtifact>(
      promotionReleaseArtifactPath(options.releaseId, "verification.canary.json"),
    ),
    readArtifact<ShadowArtifact>(promotionReleaseArtifactPath(options.releaseId, "shadow.json")),
  ]);
  assertReleaseArtifact(manifest, verification, "analysis-lab-promotion-verification-v1");
  assertReleaseArtifact(manifest, shadow, "analysis-lab-promotion-shadow-v1");
  if (verification.scope !== "canary") throw new Error("canary verification 산출물이 아닙니다.");

  const profile = buildGrantSimulationCompanyProfile();
  const sheet = await loadServiceApplySheet(options.grantId, { simulationProfile: profile });
  if (!sheet) throw new Error("제품 상세 로더에서 대상 공고를 찾지 못했습니다.");
  const workspace = await loadAdminGrantWorkspaceData({
    sheet,
    companyProfile: profile,
    businessNumber: GRANT_SIMULATION_BUSINESS_NUMBER,
    reviewerEmail: options.reviewerEmail,
  });

  const productNodes = evaluateProductCanaryObservation({
    promotionVerified: verification.verdict === "PASS" && verification.issues.length === 0,
    matchingVerified: shadow.verdict === "PASS"
      && shadow.sourceDrift.length === 0
      && shadow.baselineDrift.length === 0
      && shadow.guardIssues.length === 0
      && shadow.grants.some((item) => item.grantId === options.grantId),
    matchingCompanyCount: shadow.companyCount,
    authoringGuidePresent: Boolean(plan.promotionPlan.authoringGuide),
    connectedFieldCount: workspace.connectedFields.length,
    seededAnswerCount: Object.keys(workspace.fieldAnswers).length,
    workspaceMode: workspace.execution.mode,
    workspaceLadder: workspace.ladder,
    activeDocumentKey: workspace.activeDocumentKey,
    draftId: workspace.draftId,
  });
  const evidence: ProductCanaryEvidence = {
    schema: PRODUCT_CANARY_EVIDENCE_SCHEMA,
    canaryId: buildProductCanaryId(),
    grantId: options.grantId,
    runId: run.runId,
    releaseId: options.releaseId,
    manifestSha256: manifest.manifestSha256,
    evaluatedAt: new Date().toISOString(),
    ...productNodes,
  };
  const path = await writeProductCanaryEvidence(evidence);
  const failed = Object.entries(productNodes).filter(([, node]) => node.status === "failed");
  console.log(`[product-canary] ${failed.length === 0 ? "PASS" : "FAIL"}: ${options.grantId}`);
  for (const [name, node] of Object.entries(productNodes)) {
    console.log(`- ${name}: ${node.status} · ${node.summary}`);
  }
  console.log(`- evidence: ${path}`);
  return failed.length === 0 ? 0 : 2;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (const arg of args) {
    if (arg === "--") continue;
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`알 수 없는 인자: ${arg}`);
    values.set(match[1]!, match[2]!.trim());
  }
  const releaseId = values.get("release") ?? "";
  const grantId = values.get("grantId") ?? "";
  const reviewerEmail = values.get("reviewer") ?? "";
  if (!releaseId || !grantId || !reviewerEmail) {
    throw new Error("--release, --grantId, --reviewer가 모두 필요합니다.");
  }
  return { releaseId, grantId, reviewerEmail };
}

async function readArtifact<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertReleaseArtifact(
  manifest: {
    releaseId: string;
    releasePlanSha256: string;
    manifestSha256: string;
  },
  artifact: VerificationArtifact | ShadowArtifact,
  schema: VerificationArtifact["schema"] | ShadowArtifact["schema"],
): void {
  if (
    artifact.schema !== schema
    || artifact.releaseId !== manifest.releaseId
    || artifact.releasePlanSha256 !== manifest.releasePlanSha256
    || artifact.manifestSha256 !== manifest.manifestSha256
  ) throw new Error(`${schema}이 release manifest와 일치하지 않습니다.`);
}

main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[product-canary] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // DB 정리 실패는 이미 산출된 카나리 판정을 가리지 않는다.
  }
}

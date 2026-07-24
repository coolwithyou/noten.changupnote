import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GrantPromotionPlan } from "./promote";
import { analysisLabDir } from "./run-store";

export const PROMOTION_RELEASE_SCHEMA = "analysis-lab-promotion-release-v1" as const;
export const PROMOTION_DRY_RUN_SCHEMA = "analysis-lab-promotion-dry-run-v1" as const;
export const PROMOTION_APPROVAL_SCHEMA = "analysis-lab-promotion-approval-v1" as const;
export const MIN_CONFIRM_HASH_PREFIX = 12;

export interface PromotionSourceArtifact {
  grantId: string;
  runId: string;
  runSha256: string;
  reviewSha256?: string | null;
  aiReviewSha256?: string | null;
  auditSha256?: string | null;
  overlaySha256: string | null;
  confirmationsSha256: string | null;
}

export interface PromotionReleasePlanItem {
  grantId: string;
  planSha256: string;
  promotionPlan: GrantPromotionPlan;
  beforeCriteriaSha256: string;
  beforeQuestionsSha256: string;
  dedupComponentSha256: string;
  criteriaCountBefore: number;
  criteriaCountAfter: number;
  questionCountAfter: number;
  pendingCount: number;
  downgradedCount: number;
  costUsd: number | null;
}

export interface PromotionReleaseManifestBody {
  schema: typeof PROMOTION_RELEASE_SCHEMA;
  releaseId: string;
  revision: number;
  createdAt: string;
  gitCommit: string;
  buildDigest: string;
  cohortLabel: string;
  canaryGrantIds: string[];
  releasePlanSha256: string;
  sourceArtifacts: PromotionSourceArtifact[];
  plans: PromotionReleasePlanItem[];
}

export interface PromotionReleaseManifest extends PromotionReleaseManifestBody {
  manifestSha256: string;
}

export interface PromotionDryRunItem {
  grantId: string;
  planSha256: string;
  beforeCriteriaSha256: string;
  beforeQuestionsSha256: string;
  dedupComponentSha256: string;
  baselineMatches: boolean;
  guard: "pass" | "conversion_error" | "empty_criteria" | "pending_criteria";
  criteriaCountAfter: number;
  questionCountAfter: number;
}

export interface PromotionDryRunArtifact {
  schema: typeof PROMOTION_DRY_RUN_SCHEMA;
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  createdAt: string;
  items: PromotionDryRunItem[];
  verdict: "PASS" | "FAIL";
}

export interface PromotionApprovalArtifact {
  schema: typeof PROMOTION_APPROVAL_SCHEMA;
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  aggregateSha256: string;
  shadowSha256: string;
  dryRunSha256: string;
  approvedBy: string;
  approvedAt: string;
}

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 릴리스 아티팩트에는 원본 companyId/사업자번호 대신 릴리스별 HMAC 가명키만 남긴다. */
export function pseudonymizePromotionCompanyKey(
  secret: string,
  releaseId: string,
  rawKey: string,
): string {
  if (secret.length < 32) throw new Error("회사 키 가명화 secret은 32자 이상이어야 합니다.");
  assertSafeReleaseId(releaseId);
  return `company-${createHmac("sha256", secret)
    .update(`${releaseId}\u001f${rawKey}`)
    .digest("hex")
    .slice(0, 20)}`;
}

export function planSha256(plan: GrantPromotionPlan): string {
  return sha256Canonical(plan);
}

export function releasePlanSha256(items: PromotionReleasePlanItem[]): string {
  return sha256Canonical(
    [...items]
      .sort((left, right) => left.grantId.localeCompare(right.grantId))
      .map((item) => ({
        grantId: item.grantId,
        planSha256: item.planSha256,
        promotionPlan: item.promotionPlan,
      })),
  );
}

export function createPromotionReleaseManifest(
  input: Omit<PromotionReleaseManifestBody, "schema" | "releasePlanSha256">,
): PromotionReleaseManifest {
  const plans = [...input.plans].sort((left, right) => left.grantId.localeCompare(right.grantId));
  const sourceArtifacts = [...input.sourceArtifacts]
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
  const canaryGrantIds = [...new Set(input.canaryGrantIds)].sort();
  const body: PromotionReleaseManifestBody = {
    ...input,
    schema: PROMOTION_RELEASE_SCHEMA,
    canaryGrantIds,
    sourceArtifacts,
    plans,
    releasePlanSha256: releasePlanSha256(plans),
  };
  return { ...body, manifestSha256: sha256Canonical(body) };
}

export function validatePromotionReleaseManifest(value: unknown): PromotionReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("release manifest가 객체가 아닙니다.");
  const manifest = value as Partial<PromotionReleaseManifest>;
  if (
    manifest.schema !== PROMOTION_RELEASE_SCHEMA
    || typeof manifest.releaseId !== "string"
    || !Number.isInteger(manifest.revision)
    || !Array.isArray(manifest.plans)
    || !Array.isArray(manifest.sourceArtifacts)
    || !Array.isArray(manifest.canaryGrantIds)
    || typeof manifest.releasePlanSha256 !== "string"
    || typeof manifest.manifestSha256 !== "string"
  ) {
    throw new Error("release manifest 형식이 올바르지 않습니다.");
  }
  assertSafeReleaseId(manifest.releaseId);
  const typed = manifest as PromotionReleaseManifest;
  const expectedPlanHash = releasePlanSha256(typed.plans);
  if (expectedPlanHash !== typed.releasePlanSha256) {
    throw new Error("release plan hash가 manifest 내용과 일치하지 않습니다.");
  }
  const { manifestSha256: _stored, ...body } = typed;
  const expectedManifestHash = sha256Canonical(body);
  if (expectedManifestHash !== typed.manifestSha256) {
    throw new Error("manifest hash가 내용과 일치하지 않습니다.");
  }
  const artifactGrantIds = new Set(typed.sourceArtifacts.map((item) => item.grantId));
  const seenGrantIds = new Set<string>();
  for (const item of typed.plans) {
    if (seenGrantIds.has(item.grantId)) throw new Error(`manifest grant 중복: ${item.grantId}`);
    seenGrantIds.add(item.grantId);
    if (planSha256(item.promotionPlan) !== item.planSha256) {
      throw new Error(`plan hash 불일치: ${item.grantId}`);
    }
    if (item.promotionPlan.grantId !== item.grantId) {
      throw new Error(`plan grantId 불일치: ${item.grantId}`);
    }
    if (!artifactGrantIds.has(item.grantId)) {
      throw new Error(`source artifact 누락: ${item.grantId}`);
    }
  }
  for (const grantId of typed.canaryGrantIds) {
    if (!seenGrantIds.has(grantId)) throw new Error(`canary가 release plan 밖에 있습니다: ${grantId}`);
  }
  return typed;
}

export function assertManifestConfirmation(
  manifest: PromotionReleaseManifest,
  confirmation: string | undefined,
): void {
  const prefix = confirmation?.trim().toLowerCase() ?? "";
  if (prefix.length < MIN_CONFIRM_HASH_PREFIX) {
    throw new Error(`--confirm은 manifest hash 앞 ${MIN_CONFIRM_HASH_PREFIX}자 이상이어야 합니다.`);
  }
  if (!manifest.manifestSha256.startsWith(prefix)) {
    throw new Error("--confirm 값이 manifest hash와 일치하지 않습니다.");
  }
}

export function promotionReleaseDir(releaseId: string): string {
  assertSafeReleaseId(releaseId);
  return join(analysisLabDir(), "releases", releaseId);
}

export function promotionReleaseArtifactPath(
  releaseId: string,
  name: "manifest.json" | "aggregate.json" | "shadow.json" | "dry-run.json"
    | "approval.json" | "verification.json" | "verification.canary.json" | "verification.all.json",
): string {
  return join(promotionReleaseDir(releaseId), name);
}

export async function writeImmutablePromotionArtifact(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function readPromotionReleaseManifest(releaseId: string): Promise<PromotionReleaseManifest> {
  const path = promotionReleaseArtifactPath(releaseId, "manifest.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const manifest = validatePromotionReleaseManifest(parsed);
  if (manifest.releaseId !== releaseId) throw new Error("manifest releaseId와 경로가 일치하지 않습니다.");
  return manifest;
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function hashFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await hashFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertSafeReleaseId(releaseId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(releaseId)) {
    throw new Error(`허용되지 않는 releaseId: ${releaseId}`);
  }
}

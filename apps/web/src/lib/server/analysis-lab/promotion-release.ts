// 역사 import 경로와 파일 I/O. 제품은 순수 release 계약만 소비한다.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analysisLabDir } from "./run-store";
import { assertSafeReleaseId, validatePromotionReleaseManifest, type PromotionReleaseManifest } from "../analysis-serving/promotionReleaseContract";
export * from "../analysis-serving/promotionReleaseContract";

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

export function promotionVerificationArtifactPath(
  releaseId: string,
  scope: "canary" | "all",
  attempt: number,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("promotion verification attempt는 1 이상의 정수여야 합니다.");
  }
  const name = attempt === 1
    ? `verification.${scope}.json`
    : `verification.${scope}.attempt-${attempt}.json`;
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

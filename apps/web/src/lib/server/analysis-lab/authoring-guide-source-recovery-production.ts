import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readAuthoringGuideAdoptionManifest,
} from "./authoring-guide-adoption-production";
import {
  assertAuthoringGuideSourceRecoveryManifest,
  createAuthoringGuideSourceRecoveryManifest,
  encodeAuthoringGuideSourceRecoveryManifest,
  type AuthoringGuideSourceRecoveryManifest,
  type AuthoringGuideSourceRecoveryRuntimeReadiness,
} from "./authoring-guide-source-recovery";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/u;

export async function prepareAuthoringGuideSourceRecovery(input: {
  readonly adoptionManifestSha256: string;
  readonly runtimeReadiness: AuthoringGuideSourceRecoveryRuntimeReadiness;
  readonly preparedAt?: Date;
  readonly repositoryRoot?: string;
}): Promise<AuthoringGuideSourceRecoveryManifest> {
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  const adoptionManifest = await readAuthoringGuideAdoptionManifest(
    input.adoptionManifestSha256,
    repositoryRoot,
  );
  return createAuthoringGuideSourceRecoveryManifest({
    adoptionManifestSha256: input.adoptionManifestSha256,
    adoptionManifest,
    runtimeReadiness: input.runtimeReadiness,
    preparedAt: input.preparedAt ?? new Date(),
  });
}

export async function readAuthoringGuideSourceRecoveryManifest(
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<AuthoringGuideSourceRecoveryManifest> {
  if (!SHA256.test(sha256)) throw new Error(`허용되지 않는 recovery manifest SHA: ${sha256}`);
  const bytes = await readFile(authoringGuideSourceRecoveryManifestPath(sha256, repositoryRoot));
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== sha256) throw new Error("recovery manifest 파일 SHA가 ID와 다릅니다.");
  const manifest = JSON.parse(bytes.toString("utf8")) as AuthoringGuideSourceRecoveryManifest;
  if (Buffer.compare(bytes, encodeAuthoringGuideSourceRecoveryManifest(manifest)) !== 0) {
    throw new Error("recovery manifest가 canonical JSON이 아닙니다.");
  }
  return assertAuthoringGuideSourceRecoveryManifest(manifest);
}

export async function writeAuthoringGuideSourceRecoveryManifest(
  manifest: AuthoringGuideSourceRecoveryManifest,
  repositoryRoot = findMonorepoRoot(),
): Promise<{ readonly sha256: string; readonly path: string }> {
  const bytes = encodeAuthoringGuideSourceRecoveryManifest(manifest);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = authoringGuideSourceRecoveryManifestPath(sha256, repositoryRoot);
  await writeImmutableBytesAtomic(path, bytes);
  return Object.freeze({ sha256, path });
}

export function authoringGuideSourceRecoveryManifestPath(
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  if (!SHA256.test(sha256)) throw new Error(`허용되지 않는 recovery manifest SHA: ${sha256}`);
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "authoring-guide-source-recovery",
    "manifests",
    `${sha256}.json`,
  );
}

export function sourceRecoveryRuntimeReadiness(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): AuthoringGuideSourceRecoveryRuntimeReadiness {
  return Object.freeze({
    r2Configured: [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_BUCKET_URL",
    ].every((name) => Boolean(env[name]?.trim())),
    conversionServerConfigured: Boolean(env.CONVERSION_SERVER_URL?.trim()),
    conversionSharedSecretConfigured: Boolean(env.CONVERSION_SHARED_SECRET?.trim()),
    localImageOcrReady: platform === "darwin",
  });
}

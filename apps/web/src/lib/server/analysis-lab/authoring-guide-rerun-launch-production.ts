import { prepareLabAnalysis } from "./analyze";
import { readAuthoringGuideAdoptionManifest } from "./authoring-guide-adoption-production";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import {
  createAuthoringGuideRerunAnalysisLaunchManifest,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
} from "./launch-batch-artifacts";
import { findMonorepoRoot } from "./run-store";

export async function prepareAuthoringGuideRerunLaunchManifest(input: {
  readonly adoptionManifestSha256: string;
  readonly concurrency: number;
  readonly preparedAt?: Date;
  readonly repositoryRoot?: string;
}): Promise<{
  readonly manifest: AnalysisLaunchManifest;
  readonly manifestSha256: string;
  readonly path: string;
}> {
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  const adoptionManifest = await readAuthoringGuideAdoptionManifest(
    input.adoptionManifestSha256,
    repositoryRoot,
  );
  if (adoptionManifest.asOfKst !== koreaDateKey(new Date())) {
    throw new Error("작성 가이드 재분석 adoption manifest의 지원 가능 기준일이 오늘 KST와 다릅니다.");
  }
  const selected = adoptionManifest.items.filter((item) => (
    item.disposition === "rerun_required" && item.current.sourceSealed
  ));
  const preparedTargets = await mapWithConcurrency(
    selected,
    normalizeConcurrency(input.concurrency),
    async (item) => {
      const prepared = await prepareLabAnalysis(item.grantId);
      return Object.freeze({
        grantId: prepared.grant.id,
        inputSha256: prepared.input.inputSha256,
        attachmentManifestSha256: prepared.input.attachmentManifestSha256,
      });
    },
  );
  const manifest = createAuthoringGuideRerunAnalysisLaunchManifest({
    adoptionManifestSha256: input.adoptionManifestSha256,
    adoptionManifest,
    preparedTargets,
    provenance: await readCurrentDeepRepairExecutionProvenance({ repositoryRoot }),
    concurrency: input.concurrency,
    now: input.preparedAt ?? new Date(),
  });
  const stored = await writeAnalysisLaunchArtifact("manifests", manifest, repositoryRoot);
  return Object.freeze({
    manifest,
    manifestSha256: stored.sha256,
    path: stored.path,
  });
}

function koreaDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function normalizeConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("작성 가이드 재분석 concurrency는 1~4 정수여야 합니다.");
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await map(values[index]!);
    }
  }));
  return results;
}

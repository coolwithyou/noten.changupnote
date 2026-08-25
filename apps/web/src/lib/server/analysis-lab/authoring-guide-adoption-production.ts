import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { and, eq, gte, isNotNull, lte, notExists } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  activeGrantApplyEndCutoff,
  isKStartupRecruitmentClosedPayload,
} from "@/lib/server/repositories/activeGrantFilter";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { prepareDeepAnalysisInput } from "@/lib/server/deep-analysis/prepareInput";
import { prepareLabAnalysis } from "./analyze";
import {
  createAuthoringGuideAdoptionManifest,
  encodeAuthoringGuideAdoptionManifest,
  isExplicitAuthoringGuideAdoptionRun,
  type AuthoringGuideAdoptionCandidate,
  type AuthoringGuideAdoptionManifest,
} from "./authoring-guide-adoption";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import {
  findMonorepoRoot,
  labRunFilePath,
  readLatestLabRunIndex,
} from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/u;

export async function prepareCurrentAuthoringGuideAdoption(input: {
  readonly asOf: Date;
  readonly preparedAt?: Date;
  readonly concurrency?: number;
}): Promise<AuthoringGuideAdoptionManifest> {
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("current source revision 검증에 R2 환경변수가 필요합니다.");
  const cutoff = activeGrantApplyEndCutoff(input.asOf);
  const rows = await db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      rawPayload: schema.grantRaw.payload,
    })
    .from(schema.grants)
    .innerJoin(schema.grantRaw, and(
      eq(schema.grantRaw.source, schema.grants.source),
      eq(schema.grantRaw.sourceId, schema.grants.sourceId),
    ))
    .where(and(
      eq(schema.grants.status, "open"),
      eq(schema.grants.servingState, "visible"),
      isNotNull(schema.grants.applyStart),
      isNotNull(schema.grants.applyEnd),
      lte(schema.grants.applyStart, cutoff),
      gte(schema.grants.applyEnd, cutoff),
      notExists(db
        .select({ memberGrantId: schema.dedupLinks.memberGrantId })
        .from(schema.dedupLinks)
        .where(and(
          eq(schema.dedupLinks.memberGrantId, schema.grants.id),
          eq(schema.dedupLinks.confirmed, true),
        ))),
    ));
  const eligible = rows
    .filter((row) => !isKStartupRecruitmentClosedPayload(row.source, row.rawPayload))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const latestRuns = await readLatestLabRunIndex();
  const historical = eligible.flatMap((row) => {
    const run = latestRuns.get(row.id);
    // run-outcome의 구형 호환(error=null)은 관리자 이력 표면에는 필요하지만, 이번 전환은
    // validator가 publishable을 명시적으로 봉인한 결과만 재사용한다. 구형 성공 런을 새 계약의
    // 분석 완료로 승격하거나 재분석 대상으로 자동 편입하지 않는다.
    return run
      && isExplicitAuthoringGuideAdoptionRun(run)
      ? [{ row, run }]
      : [];
  });
  const root = findMonorepoRoot();
  const candidates = await mapWithConcurrency(
    historical,
    normalizeConcurrency(input.concurrency),
    async ({ row, run }): Promise<AuthoringGuideAdoptionCandidate> => {
      if (run.source !== row.source || run.sourceId !== row.sourceId) {
        throw new Error(`historical run source binding이 current grant와 다릅니다: ${row.id}`);
      }
      const runPath = labRunFilePath(run.source, run.sourceId, run.runId);
      const [runArtifact, prepared, operational] = await Promise.all([
        readFile(runPath),
        prepareLabAnalysis(row.id),
        prepareDeepAnalysisInput({ db, storage, grantId: row.id }),
      ]);
      return {
        grantId: row.id,
        source: row.source,
        sourceId: row.sourceId,
        title: row.title,
        run,
        runArtifactPath: relative(root, runPath),
        runArtifactSha256: createHash("sha256").update(runArtifact).digest("hex"),
        current: {
          inputSha256: prepared.input.inputSha256,
          attachmentManifestSha256: prepared.input.attachmentManifestSha256,
          sourceRevisionSha256: operational.sourceRevisionSha256,
          sourceSealed: operational.sealed,
          operationalInputSha256: operational.inputSha256,
          operationalAttachmentManifestSha256: operational.attachmentManifestSha256,
          sourceBlockers: operational.blockers.map((blocker) => ({ ...blocker })),
        },
      };
    },
  );

  return createAuthoringGuideAdoptionManifest({
    preparedAt: input.preparedAt ?? new Date(),
    asOfKst: koreaDateKey(input.asOf),
    strictEligibleGrantCount: eligible.length,
    candidates,
  });
}

export async function writeAuthoringGuideAdoptionManifest(
  manifest: AuthoringGuideAdoptionManifest,
  repositoryRoot = findMonorepoRoot(),
): Promise<{ readonly sha256: string; readonly path: string }> {
  const bytes = encodeAuthoringGuideAdoptionManifest(manifest);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = authoringGuideAdoptionManifestPath(sha256, repositoryRoot);
  await writeImmutableBytesAtomic(path, bytes);
  return Object.freeze({ sha256, path });
}

export async function readAuthoringGuideAdoptionManifest(
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<AuthoringGuideAdoptionManifest> {
  if (!SHA256.test(sha256)) throw new Error(`허용되지 않는 adoption manifest SHA: ${sha256}`);
  const bytes = await readFile(authoringGuideAdoptionManifestPath(sha256, repositoryRoot));
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("adoption manifest 파일 SHA가 ID와 다릅니다.");
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as AuthoringGuideAdoptionManifest;
  if (manifest.schema !== "authoring-guide-adoption-manifest-v1") {
    throw new Error("adoption manifest schema가 잘못됐습니다.");
  }
  if (Buffer.compare(bytes, encodeAuthoringGuideAdoptionManifest(manifest)) !== 0) {
    throw new Error("adoption manifest가 canonical JSON이 아닙니다.");
  }
  return manifest;
}

export function authoringGuideAdoptionManifestPath(
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  if (!SHA256.test(sha256)) throw new Error(`허용되지 않는 adoption manifest SHA: ${sha256}`);
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "authoring-guide-adoption",
    "manifests",
    `${sha256}.json`,
  );
}

function koreaDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function normalizeConcurrency(value = 4): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("adoption concurrency는 1~4 정수여야 합니다.");
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

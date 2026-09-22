// 사람 검수 결정과 현재 DB의 read-only snapshot을 재결속해 로컬 v2 초안만 만든다.
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  parseLegacyQuestionMigrationReviewDecisionSet,
  parseLegacyQuestionMigrationReviewManifest,
  parseLegacyQuestionMigrationReviewPacket,
} from "@cunote/contracts/legacy-question-migration-review";
import * as schema from "../db/schema";
import { writeImmutableBytesAtomic } from "../analysis-lab/immutable-artifact-fs";
import { findMonorepoRoot } from "../analysis-lab/run-store";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  buildLegacyQuestionMigrationDraftSet,
  serializeLegacyQuestionMigrationDraftSet,
  type LegacyQuestionMigrationReviewBundleInput,
} from "./legacyQuestionMigrationDraft";
import { loadLegacyQuestionMigrationReviewBundle } from "./legacyQuestionMigrationReviewPacket";
import {
  buildLegacyQuestionMigrationReleasePlan,
  serializeLegacyQuestionMigrationReleasePlan,
} from "./legacyQuestionMigrationReleasePlan";

export interface LegacyQuestionMigrationDraftCliOptions {
  readonly manifestPath: string;
  readonly packetDirectory: string;
  readonly decisionSetPath: string;
  readonly outputDirectory: string | null;
  readonly limit: number;
}

export function parseLegacyQuestionMigrationDraftCliArgs(
  args: readonly string[],
): LegacyQuestionMigrationDraftCliOptions {
  const supported = new Set([
    "--manifest",
    "--packet-dir",
    "--decisions",
    "--output-dir",
    "--limit",
  ]);
  const values = new Map<string, string>();
  for (const arg of args) {
    if (arg === "--") continue;
    const separator = arg.indexOf("=");
    const name = separator >= 0 ? arg.slice(0, separator) : arg;
    if (!supported.has(name)) throw new Error(`지원하지 않는 옵션입니다: ${arg}`);
    if (separator < 0 || !arg.slice(separator + 1).trim()) {
      throw new Error(`${name}=값 형식이 필요합니다.`);
    }
    if (values.has(name)) throw new Error(`${name}은 한 번만 지정할 수 있습니다.`);
    values.set(name, arg.slice(separator + 1).trim());
  }
  const manifest = values.get("--manifest");
  const decisions = values.get("--decisions");
  if (!manifest || !decisions) {
    throw new Error("--manifest=경로와 --decisions=경로가 필요합니다.");
  }
  const limitRaw = values.get("--limit");
  const limit = limitRaw === undefined ? 20_000 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) {
    throw new Error("--limit은 1~20000 정수여야 합니다.");
  }
  const manifestPath = resolve(manifest);
  return {
    manifestPath,
    packetDirectory: resolve(values.get("--packet-dir") ?? dirname(manifestPath)),
    decisionSetPath: resolve(decisions),
    outputDirectory: values.has("--output-dir")
      ? resolve(values.get("--output-dir")!)
      : null,
    limit,
  };
}

export async function runLegacyQuestionMigrationDraftCli(
  options: LegacyQuestionMigrationDraftCliOptions,
): Promise<void> {
  loadMonorepoEnv();
  const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { options: "-c default_transaction_read_only=on" },
  });
  try {
    const [review, decisions] = await Promise.all([
      readReviewBundle(options.manifestPath, options.packetDirectory),
      readJson(options.decisionSetPath).then(parseLegacyQuestionMigrationReviewDecisionSet),
    ]);
    const db = drizzle(client, { schema });
    const current = await db.transaction(
      (tx) => loadLegacyQuestionMigrationReviewBundle({ db: tx, limit: options.limit }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const draftSet = buildLegacyQuestionMigrationDraftSet({ review, decisions, current });
    const releasePlan = buildLegacyQuestionMigrationReleasePlan({ draftSet, current });
    const outputDirectory = options.outputDirectory
      ?? join(findMonorepoRoot(), "spike-out", "product-readiness", "legacy-question-migration-drafts");
    const outputPath = join(outputDirectory, `${draftSet.contentSha256}.migration-draft.json`);
    const releasePlanPath = join(
      outputDirectory,
      `${releasePlan.contentSha256}.migration-release-plan.json`,
    );
    await writeImmutableBytesAtomic(
      outputPath,
      serializeLegacyQuestionMigrationDraftSet(draftSet),
    );
    await writeImmutableBytesAtomic(
      releasePlanPath,
      serializeLegacyQuestionMigrationReleasePlan(releasePlan),
    );
    console.log(JSON.stringify({
      ok: true,
      contentSha256: draftSet.contentSha256,
      draftCount: draftSet.drafts.length,
      nextWorkCount: draftSet.nextWork.length,
      nextWorkByAction: countBy(draftSet.nextWork.map((item) => item.action)),
      releaseOperationCount: releasePlan.operations.length,
      releaseHoldCount: releasePlan.holds.length,
      currentShadowSnapshotSha256: current.shadowReport.snapshotSha256,
      outputPath,
      releasePlanPath,
      authority: draftSet.authority,
      releaseAuthority: releasePlan.authority,
    }, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function readReviewBundle(
  manifestPath: string,
  packetDirectory: string,
): Promise<LegacyQuestionMigrationReviewBundleInput> {
  const manifest = parseLegacyQuestionMigrationReviewManifest(await readJson(manifestPath));
  const packets = await Promise.all(manifest.packets.map(async (entry) => {
    if (basename(entry.fileName) !== entry.fileName) {
      throw new Error(`manifest packet 파일명에 경로를 사용할 수 없습니다: ${entry.fileName}`);
    }
    return parseLegacyQuestionMigrationReviewPacket(
      await readJson(join(packetDirectory, entry.fileName)),
    );
  }));
  return { manifest, packets };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runLegacyQuestionMigrationDraftCli(
    parseLegacyQuestionMigrationDraftCliArgs(process.argv.slice(2)),
  );
}

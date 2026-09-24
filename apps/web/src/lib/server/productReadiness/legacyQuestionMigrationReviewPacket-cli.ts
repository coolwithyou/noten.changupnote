// 운영 질문/criterion을 한 repeatable-read snapshot에서 읽어 로컬 불변 검수 packet만 만든다.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { join } from "node:path";
import * as schema from "../db/schema";
import { writeImmutableBytesAtomic } from "../analysis-lab/immutable-artifact-fs";
import { findMonorepoRoot } from "../analysis-lab/run-store";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  loadLegacyQuestionMigrationReviewBundle,
  serializeLegacyQuestionMigrationReviewManifest,
  serializeLegacyQuestionMigrationReviewPacket,
} from "./legacyQuestionMigrationReviewPacket";

loadMonorepoEnv();
const args = process.argv.slice(2);
const limit = readPositiveInteger("--limit", 20_000);
const requestedOutputDirectory = readOptionalText("--output-dir");
if (args.some((arg) => arg !== "--" && !arg.startsWith("--limit=") && !arg.startsWith("--output-dir="))) {
  throw new Error("사용법: tsx legacyQuestionMigrationReviewPacket-cli.ts [--limit=20000] [--output-dir=경로]");
}
const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
if (!databaseUrl) throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
const client = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  connection: { options: "-c default_transaction_read_only=on" },
});

try {
  const db = drizzle(client, { schema });
  const bundle = await db.transaction(
    (tx) => loadLegacyQuestionMigrationReviewBundle({ db: tx, limit }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const baseDirectory = requestedOutputDirectory
    ?? join(findMonorepoRoot(), "spike-out", "product-readiness", "legacy-question-migration-review");
  const outputDirectory = join(baseDirectory, bundle.shadowReport.snapshotSha256);
  const packetBySha = new Map(bundle.packets.map((packet) => [packet.contentSha256, packet]));
  for (const entry of bundle.manifest.packets) {
    const packet = packetBySha.get(entry.packetContentSha256);
    if (!packet) throw new Error(`manifest packet 누락: ${entry.packetContentSha256}`);
    await writeImmutableBytesAtomic(
      join(outputDirectory, entry.fileName),
      serializeLegacyQuestionMigrationReviewPacket(packet),
    );
  }
  const manifestPath = join(
    outputDirectory,
    `${bundle.manifest.contentSha256}.manifest.json`,
  );
  await writeImmutableBytesAtomic(
    manifestPath,
    serializeLegacyQuestionMigrationReviewManifest(bundle.manifest),
  );
  console.log(JSON.stringify({
    ok: true,
    shadowSnapshotSha256: bundle.shadowReport.snapshotSha256,
    manifestContentSha256: bundle.manifest.contentSha256,
    packetCount: bundle.manifest.packetCount,
    answerPreservationReviewCount: bundle.manifest.answerPreservationReviewCount,
    outputDirectory,
    manifestPath,
    authority: bundle.manifest.authority,
  }, null, 2));
} finally {
  await client.end({ timeout: 5 });
}

function readOptionalText(name: string): string | null {
  const prefix = `${name}=`;
  const values = args.filter((arg) => arg.startsWith(prefix));
  if (values.length === 0) return null;
  if (values.length !== 1) throw new Error(`${name}은 한 번만 지정할 수 있습니다.`);
  const value = values[0]!.slice(prefix.length).trim();
  if (!value) throw new Error(`${name} 값이 필요합니다.`);
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const values = args.filter((arg) => arg.startsWith(prefix));
  if (values.length === 0) return fallback;
  if (values.length !== 1) throw new Error(`${name}은 한 번만 지정할 수 있습니다.`);
  const parsed = Number(values[0]!.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20_000) {
    throw new Error(`${name}은 1~20000 정수여야 합니다.`);
  }
  return parsed;
}

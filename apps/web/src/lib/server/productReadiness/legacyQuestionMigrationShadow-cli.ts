// 읽기 전용: 모델, 질문 발행, migration, 서비스 DB mutation을 수행하지 않는다.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { join } from "node:path";
import * as schema from "../db/schema";
import { writeImmutableBytesAtomic } from "../analysis-lab/immutable-artifact-fs";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { loadLegacyQuestionMigrationShadow } from "./legacyQuestionMigrationShadow";

loadMonorepoEnv();
const args = process.argv.slice(2);
const limit = readPositiveInteger("--limit", 20_000);
const outputDirectory = readOptionalText("--output-dir");
if (args.some((arg) => arg !== "--" && !arg.startsWith("--limit=") && !arg.startsWith("--output-dir="))) {
  throw new Error("사용법: tsx legacyQuestionMigrationShadow-cli.ts [--limit=20000] [--output-dir=경로]");
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
  const report = await db.transaction(
    (tx) => loadLegacyQuestionMigrationShadow({ db: tx, limit }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (outputDirectory) {
    const artifactPath = join(outputDirectory, `${report.snapshotSha256}.json`);
    await writeImmutableBytesAtomic(
      artifactPath,
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
    );
    process.stderr.write(`[legacy-question-shadow] immutable artifact: ${artifactPath}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
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

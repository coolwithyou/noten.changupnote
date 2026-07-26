import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { runAggregateSplitExposureInvocation } from "./aggregateSplitExposure";

loadMonorepoEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<number> {
  const splitCaseId = readArg("aggregate-split-case")?.trim();
  const actor = readArg("actor")?.trim();
  if (!splitCaseId || !isUuid(splitCaseId)) {
    throw new Error("--aggregate-split-case=<UUID>가 필요합니다.");
  }
  if (!actor) throw new Error("--actor=<실행자 식별자>가 필요합니다.");
  if (
    process.env.AGGREGATE_SPLIT_EXPOSURE_EXECUTE !== "1"
    && !process.argv.includes("--execute")
  ) {
    throw new Error(
      "통합공고 노출 전환은 fail-closed입니다. "
      + "AGGREGATE_SPLIT_EXPOSURE_EXECUTE=1 또는 --execute가 필요합니다.",
    );
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 환경변수가 필요합니다.");
  const result = await runAggregateSplitExposureInvocation({
    db: getCunoteDb(),
    storage,
    splitCaseId,
    actor,
  });
  console.log(JSON.stringify({
    schema: "aggregate-split-exposure-v1",
    verdict: "PASS",
    ...result,
  }, null, 2));
  return 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

main()
  .then(async (code) => {
    await closeCunoteDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(
      "[aggregate-split-exposure] 실패:",
      error instanceof Error ? error.message : error,
    );
    try {
      await closeCunoteDb();
    } catch {
      // 원래 오류를 보존한다.
    }
    process.exit(1);
  });

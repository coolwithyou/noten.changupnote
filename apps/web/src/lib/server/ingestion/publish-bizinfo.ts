import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { buildBizInfoSampleEntries } from "./bizinfoSample";
import { planBizInfoPublication, publishBizInfoGrants } from "./bizinfoPublisher";

loadMonorepoEnv();

const source = readArg("source") ?? process.env.CUNOTE_INGEST_SOURCE ?? "sample";
const dryRun = process.argv.includes("--dry-run") || process.env.CUNOTE_INGEST_DRY_RUN === "true";
const collectedAt = new Date();

if (source !== "sample") {
  throw new Error("기업마당 live 발행은 LLM 추출 운영화 전까지 막아둡니다. Use --source=sample.");
}

try {
  const entries = buildBizInfoSampleEntries({ collectedAt });
  const plan = planBizInfoPublication(entries);

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      ...plan,
    }, null, 2));
  } else {
    const result = await publishBizInfoGrants(getCunoteDb(), entries, { collectedAt });
    console.log(JSON.stringify({
      dryRun: false,
      ...result,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

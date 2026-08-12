// 새 층화 코호트를 기존 cohort.json 과 분리된 불변 스냅샷으로 동결한다.
// 실행: pnpm lab:cohort:freeze -- --size=5 --seed=20260813 --label=deep-v15-cp2b-pilot5
// DB read-only, LLM/API 호출 없음. 같은 라벨의 기존 파일은 덮어쓰지 않는다.
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { cohortSnapshotFilePath } from "./cohort-file";
import { freezeLabCohortSnapshot } from "./cohort";

loadAnalysisLabEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<number> {
  const label = readArg("label")?.trim();
  const size = Number(readArg("size"));
  const seed = Number(readArg("seed"));
  if (!label) throw new Error("--label 이 필요합니다.");
  cohortSnapshotFilePath(label); // DB 조회 전 경로/라벨 fail-fast.
  if (!Number.isInteger(size) || size < 1 || size > 200) {
    throw new Error("--size 는 1~200 정수여야 합니다.");
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("--seed 는 0~4294967295 정수여야 합니다.");
  }

  const frozen = await freezeLabCohortSnapshot({ size, seed, experimentLabel: label });
  console.log(
    `[cohort-freeze] ${frozen.file.entries.length}건 동결 · label=${label} · seed=${seed}`,
  );
  console.log(
    `[cohort-freeze] 기존 정본 ${frozen.excludedCanonicalCount}건 제외 · 파일=${frozen.path}`,
  );
  console.log(
    `[cohort-freeze] 쿼터 통합공고 ${frozen.quotas.unified.achieved}/${frozen.quotas.unified.target}`
      + ` · rich criteria ${frozen.quotas.richCriteria.achieved}/${frozen.quotas.richCriteria.target}`,
  );
  for (const warning of frozen.warnings) console.warn(`[cohort-freeze] 경고: ${warning}`);
  for (const entry of frozen.file.entries) {
    console.log(`  - [${entry.stratum}] ${entry.grantId}`);
  }
  return frozen.file.entries.length === size ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeCunoteDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[cohort-freeze] 실패:", error instanceof Error ? error.message : error);
    await closeCunoteDb().catch(() => undefined);
    process.exit(1);
  });

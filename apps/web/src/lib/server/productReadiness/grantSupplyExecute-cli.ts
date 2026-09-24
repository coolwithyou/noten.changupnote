/** exact 승인 release와 수집 공급 plan hash를 받아 단건 canary만 실행한다. */
import { pathToFileURL } from "node:url";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { executeApprovedGrantSupply } from "./grantSupply";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const values = process.argv.filter((value) => value.startsWith(prefix));
  if (values.length !== 1 || !values[0]!.slice(prefix.length).trim()) {
    throw new Error(`--${name}= 값 하나가 필요합니다.`);
  }
  return values[0]!.slice(prefix.length);
}

function optionalArgument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const values = process.argv.filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`--${name}= 값은 한 번만 지정할 수 있습니다.`);
  return values[0]?.slice(prefix.length);
}

async function main(): Promise<void> {
  if (!process.argv.includes("--write")) throw new Error("실행에는 --write가 필요합니다.");
  const grantId = argument("grant-id");
  const expectedEvidenceSha256 = argument("evidence-sha256");
  const releaseId = argument("release");
  const manifestSha256 = argument("manifest-sha256");
  const executedBy = argument("actor");
  const confirmation = argument("confirm");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(grantId)
      || !/^[a-f0-9]{64}$/u.test(expectedEvidenceSha256)
      || !/^[a-f0-9]{64}$/u.test(manifestSha256)
      || !manifestSha256.startsWith(confirmation) || confirmation.length < 12) {
    throw new Error("exact 공고·plan·manifest 확인 값이 유효하지 않습니다.");
  }
  const runId = optionalArgument("run-id");
  const runSha256 = optionalArgument("run-sha256");
  const manualRevision = optionalArgument("manual-revision");
  const manualSha256 = optionalArgument("manual-sha256");
  if (Boolean(runId) !== Boolean(runSha256)) {
    throw new Error("run 선택에는 --run-id와 --run-sha256을 함께 지정해야 합니다.");
  }
  if (Boolean(manualRevision) !== Boolean(manualSha256)
      || (manualRevision !== undefined && (!runId || !/^[1-9][0-9]*$/u.test(manualRevision)
        || !/^[a-f0-9]{64}$/u.test(manualSha256!)))) {
    throw new Error("manual 선택에는 run과 --manual-revision/--manual-sha256이 모두 필요합니다.");
  }
  loadMonorepoEnv();
  try {
    const result = await executeApprovedGrantSupply({
      db: getCunoteDb(),
      grantId,
      expectedEvidenceSha256,
      approvedRelease: { releaseId, manifestSha256, executedBy },
      ...(runId && runSha256 ? { runSelection: { grantId, runId, runSha256 } } : {}),
      ...(runId && manualRevision && manualSha256 ? {
        manualConfirmationSelection: {
          grantId,
          runId,
          revision: Number(manualRevision),
          artifactSha256: manualSha256,
        },
      } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "completed" && result.status !== "already_complete") process.exitCode = 2;
  } finally {
    await closeCunoteDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

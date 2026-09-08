// Offline packet generator. Reads immutable local LabRun/review artifacts and writes one
// content-addressed draft packet. It never calls a model or service API/DB.
import { pathToFileURL } from "node:url";
import { generateConfirmationQuestionDraftFromStoredRun } from "./confirmation-question-draft";

export interface ConfirmationQuestionDraftCliArgs {
  grantId: string;
  runId: string;
  outputDirectory?: string;
}

export function parseConfirmationQuestionDraftCliArgs(
  argv: readonly string[],
): ConfirmationQuestionDraftCliArgs {
  const allowed = new Set(["grantId", "runId", "output-dir"]);
  const parsed = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([A-Za-z][A-Za-z-]*)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`옵션은 --name=value 형식이어야 합니다: ${argument}`);
    const [, name, value] = match;
    if (!allowed.has(name!)) throw new Error(`알 수 없는 옵션입니다: --${name}`);
    if (parsed.has(name!)) throw new Error(`중복 옵션입니다: --${name}`);
    parsed.set(name!, value!);
  }
  const grantId = parsed.get("grantId");
  const runId = parsed.get("runId");
  if (!grantId || !runId) throw new Error("--grantId와 --runId가 필요합니다.");
  const outputDirectory = parsed.get("output-dir");
  return { grantId, runId, ...(outputDirectory ? { outputDirectory } : {}) };
}

export async function runConfirmationQuestionDraftCli(
  argv: readonly string[],
): Promise<StoredCliResult> {
  const result = await generateConfirmationQuestionDraftFromStoredRun(
    parseConfirmationQuestionDraftCliArgs(argv),
  );
  return {
    ok: true,
    path: result.path,
    contentSha256: result.packet.contentSha256,
    candidateCount: result.packet.items.length,
    authority: result.packet.authority,
  };
}

interface StoredCliResult {
  ok: true;
  path: string;
  contentSha256: string;
  candidateCount: number;
  authority: {
    status: "unreviewed_draft";
    modelCallsMade: 0;
    serviceDatabaseWritesMade: 0;
    releaseAuthorized: false;
    promotionAuthorized: false;
    liveQuestionWriteAuthorized: false;
    currentServiceStateVerified: false;
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runConfirmationQuestionDraftCli(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

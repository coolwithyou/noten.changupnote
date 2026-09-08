import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  sealCurrentMatchingProjectionRevalidation,
  verifyCurrentMatchingProjectionRevalidation,
  type CurrentMatchingProjectionRevalidationRequest,
  type CurrentMatchingProjectionSourceEvidence,
} from "./current-matching-projection-revalidation";

const repositoryRoot = process.cwd();
const command = process.argv[2];
if (command !== "seal" && command !== "verify") {
  throw new Error("usage: current-matching-projection-revalidation-cli.ts <seal|verify> [options]");
}
const argumentsByName = parseArguments(command, process.argv.slice(3));

const currentEvidencePath = requiredArgument("current-evidence");
const launchReceiptSha256 = requiredArgument("receipt-sha256");
const sequence = exactSequenceArgument(requiredArgument("sequence"));
const grantId = requiredArgument("grant-id");
const runId = requiredArgument("run-id");
const currentEvidence = JSON.parse(await readFile(
  isAbsolute(currentEvidencePath)
    ? currentEvidencePath
    : resolve(repositoryRoot, currentEvidencePath),
  "utf8",
)) as CurrentMatchingProjectionSourceEvidence;
const request: CurrentMatchingProjectionRevalidationRequest = {
  repositoryRoot,
  launchReceiptSha256,
  sequence,
  grantId,
  runId,
  currentEvidence,
};
const stored = command === "seal"
  ? await sealCurrentMatchingProjectionRevalidation(request)
  : await verifyCurrentMatchingProjectionRevalidation({
      ...request,
      artifactSha256: requiredArgument("artifact-sha256"),
    });

console.log(JSON.stringify({
  schema: stored.artifact.schema,
  artifactSha256: stored.artifactSha256,
  path: stored.path,
  authority: stored.artifact.authority,
  original: stored.artifact.original,
  historicalProjection: {
    snapshotSha256: stored.artifact.historicalProjection.snapshotSha256,
    inspection: stored.artifact.historicalProjection.inspection,
    receiptBindingInspection:
      stored.artifact.historicalProjection.receiptBindingInspection,
  },
  currentProjection: {
    snapshotSha256: stored.artifact.currentProjection.snapshotSha256,
    inspection: stored.artifact.currentProjection.inspection,
  },
}, null, 2));

function parseArguments(
  selectedCommand: "seal" | "verify",
  rawArguments: readonly string[],
): ReadonlyMap<string, string> {
  const allowed = new Set([
    "receipt-sha256",
    "sequence",
    "grant-id",
    "run-id",
    "current-evidence",
    ...(selectedCommand === "verify" ? ["artifact-sha256"] : []),
  ]);
  const parsed = new Map<string, string>();
  for (const argument of rawArguments) {
    const matched = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!matched) throw new Error(`옵션은 --name=value 형식이어야 합니다: ${argument}`);
    const name = matched[1]!;
    if (!allowed.has(name)) throw new Error(`허용되지 않은 옵션입니다: --${name}`);
    if (parsed.has(name)) throw new Error(`중복 옵션입니다: --${name}`);
    parsed.set(name, matched[2]!);
  }
  return parsed;
}

function requiredArgument(name: string): string {
  const value = argumentsByName.get(name);
  if (!value) throw new Error(`필수 인자가 없습니다: --${name}=<value>`);
  return value;
}

function exactSequenceArgument(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("--sequence는 0 이상 정수 문자열이어야 합니다.");
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("--sequence는 safe integer 범위여야 합니다.");
  }
  return sequence;
}

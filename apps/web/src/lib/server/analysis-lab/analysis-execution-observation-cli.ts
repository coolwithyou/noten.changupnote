import { pathToFileURL } from "node:url";
import { observeAnalysisLaunchExecution } from "./analysis-execution-observation";

const SHA256 = /^[a-f0-9]{64}$/;
const USAGE = "pnpm lab:launch:observe -- --grant=<sha256> --receipts=<sha256,sha256,...>";

export interface AnalysisExecutionObservationCliArgs {
  readonly grantSha256: string;
  readonly receiptSha256s: readonly string[];
}

export function parseAnalysisExecutionObservationCliArgs(
  argv: readonly string[],
): AnalysisExecutionObservationCliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    const key = separator > 0 ? arg.slice(0, separator) : "";
    const value = separator > 0 ? arg.slice(separator + 1).trim() : "";
    if (
      (key !== "--grant" && key !== "--receipts")
      || value === ""
      || values.has(key)
    ) throw usageError();
    values.set(key, value);
  }
  if (values.size !== 2) throw usageError();
  const grantSha256 = values.get("--grant")!;
  const receiptSha256s = values.get("--receipts")!.split(",");
  if (
    !SHA256.test(grantSha256)
    || receiptSha256s.length < 1
    || receiptSha256s.some((sha256) => !SHA256.test(sha256))
    || new Set(receiptSha256s).size !== receiptSha256s.length
  ) throw usageError();
  return Object.freeze({ grantSha256, receiptSha256s: Object.freeze(receiptSha256s) });
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseAnalysisExecutionObservationCliArgs(argv);
  const report = await observeAnalysisLaunchExecution(args);
  console.log(JSON.stringify(report, null, 2));
}

function usageError(): Error {
  return new Error(`launch 실행 관측 인자가 잘못됐습니다.\n${USAGE}`);
}

const argvEntry = process.argv[1];
if (argvEntry && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

import { spawnSync } from "node:child_process";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const source = readEnum(readArg("source") ?? process.env.CUNOTE_ARCHIVE_CYCLE_SOURCE, ["sample", "live"], "sample");
const write = hasFlag("write") || process.env.CUNOTE_ARCHIVE_CYCLE_WRITE === "true";
const compareDb = write || hasFlag("compare-db") || process.env.CUNOTE_ARCHIVE_CYCLE_COMPARE_DB === "true";
const includeDbSteps = write || hasFlag("with-db-steps") || process.env.CUNOTE_ARCHIVE_CYCLE_WITH_DB_STEPS === "true";
const refreshMatchStates = hasFlag("refresh-match-states") || process.env.CUNOTE_ARCHIVE_CYCLE_REFRESH_MATCH_STATES === "true";
const allowTextOnlyFallback = hasFlag("allow-text-only-fallback") ||
  process.env.CUNOTE_ARCHIVE_CYCLE_ALLOW_TEXT_ONLY_FALLBACK === "true";
const kstartupPages = readArg("kstartupPages") ?? process.env.CUNOTE_ARCHIVE_CYCLE_KSTARTUP_PAGES ?? "1";
const kstartupPerPage = readArg("kstartupPerPage") ?? process.env.CUNOTE_ARCHIVE_CYCLE_KSTARTUP_PER_PAGE ?? "100";
const bizinfoLimit = readArg("bizinfoLimit") ?? process.env.CUNOTE_ARCHIVE_CYCLE_BIZINFO_LIMIT ?? (source === "live" ? "20" : "1");
const asOf = readArg("asOf") ?? process.env.CUNOTE_ARCHIVE_CYCLE_AS_OF;

const steps: CycleStep[] = [
  {
    name: "archive:kstartup",
    command: "pnpm",
    args: [
      "archive:kstartup",
      "--",
      `--source=${source}`,
      `--pages=${kstartupPages}`,
      `--perPage=${kstartupPerPage}`,
      ...(compareDb ? ["--compare-db"] : []),
      ...(write ? ["--write"] : []),
      ...(asOf ? [`--collectedAt=${asOf}`] : []),
    ],
  },
  {
    name: "archive:bizinfo",
    command: "pnpm",
    args: [
      "archive:bizinfo",
      "--",
      `--source=${source}`,
      `--limit=${bizinfoLimit}`,
      ...(compareDb ? ["--compare-db"] : []),
      ...(write ? ["--write"] : []),
      ...(allowTextOnlyFallback ? ["--allow-text-only-fallback"] : []),
      ...(asOf ? [`--collectedAt=${asOf}`] : []),
    ],
  },
];

if (includeDbSteps) {
  steps.push({
    name: "publish:dedup",
    command: "pnpm",
    args: [
      "publish:dedup",
      "--",
      ...(write ? [] : ["--dry-run"]),
      ...(asOf ? [`--asOf=${asOf}`] : []),
    ],
  });

  if (refreshMatchStates) {
    steps.push({
      name: "match:states:refresh",
      command: "pnpm",
      args: [
        "match:states:refresh",
        "--",
        ...(write ? ["--write"] : []),
        ...(asOf ? [`--asOf=${asOf}`] : []),
      ],
    });
  }

  steps.push({
    name: "insights:grants",
    command: "pnpm",
    args: [
      "insights:grants",
      "--",
      ...(write ? ["--write"] : []),
      ...(asOf ? [`--asOf=${asOf}`] : []),
    ],
  });
}

const startedAt = new Date();
const results: CycleStepResult[] = [];
for (const step of steps) {
  const result = runStep(step);
  results.push(result);
  if (result.exitCode !== 0) break;
}

const failed = results.find((result) => result.exitCode !== 0);
console.log(JSON.stringify({
  ok: !failed,
  dryRun: !write,
  source,
  compareDb,
  includeDbSteps,
  refreshMatchStates,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  steps: results,
}, null, 2));

if (failed) process.exitCode = failed.exitCode || 1;

interface CycleStep {
  name: string;
  command: string;
  args: string[];
}

interface CycleStepResult {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
}

function runStep(step: CycleStep): CycleStepResult {
  const start = Date.now();
  const child = spawnSync(step.command, step.args, {
    stdio: "inherit",
    env: process.env,
  });
  return {
    name: step.name,
    command: [step.command, ...step.args].join(" "),
    exitCode: child.status ?? 1,
    durationMs: Date.now() - start,
  };
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readEnum<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value: ${value}. Use ${values.join("|")}.`);
}

function printHelp() {
  console.log(`Usage: pnpm archive:cycle -- [options]

Runs the grant archive cycle in scheduler-friendly order.
Default mode is dry-run and skips DB-only post steps.

Order:
  archive:kstartup -> archive:bizinfo -> publish:dedup -> match:states:refresh? -> insights:grants

Options:
  --source=sample|live
  --write
  --compare-db
  --with-db-steps
  --refresh-match-states
  --allow-text-only-fallback
  --kstartupPages=1
  --kstartupPerPage=100
  --bizinfoLimit=20
  --asOf=2026-06-27T00:00:00Z
`);
}

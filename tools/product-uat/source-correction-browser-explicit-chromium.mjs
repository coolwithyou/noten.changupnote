import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentBrowserSession,
} from "./natural-confirmations-browser.mjs";
import {
  parseSourceCorrectionBrowserArgs,
  runSourceCorrectionAcceptance,
  validateSourceCorrectionConnection,
} from "./source-correction-browser.mjs";

export const EXPLICIT_CHROMIUM_PATH = "/Users/ffgg/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const OUTPUT_RECEIPT = "source-correction-browser-receipt.json";
const DIAGNOSTIC_RECEIPT = "source-correction-browser-diagnostic-receipt.json";

export function createExplicitChromiumSpawn(spawnSyncImpl = spawnSync) {
  return (command, args, options) => spawnSyncImpl(
    command,
    command === "agent-browser" ? ["--executable-path", EXPLICIT_CHROMIUM_PATH, ...args] : args,
    options,
  );
}

export function inspectExplicitChromium({
  expectedPath = EXPLICIT_CHROMIUM_PATH,
  realpathSyncImpl = realpathSync,
  lstatSyncImpl = lstatSync,
  readFileSyncImpl = readFileSync,
  spawnSyncImpl = spawnSync,
  getuidImpl = typeof process.getuid === "function" ? () => process.getuid() : null,
} = {}) {
  const canonicalPath = realpathSyncImpl(expectedPath);
  assert.equal(canonicalPath, expectedPath, "고정한 headless-shell exact path만 허용합니다");
  const stat = lstatSyncImpl(canonicalPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok((stat.mode & 0o111) !== 0, "고정 headless-shell이 executable이어야 합니다");
  if (getuidImpl !== null) assert.equal(stat.uid, getuidImpl());
  const versionResult = spawnSyncImpl(canonicalPath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(versionResult.error, undefined);
  assert.equal(versionResult.status, 0);
  const version = String(versionResult.stdout ?? "").trim();
  assert.match(version, /HeadlessChrome|Chromium|Chrome/i);
  return {
    executablePath: canonicalPath,
    executableSha256: createHash("sha256").update(readFileSyncImpl(canonicalPath)).digest("hex"),
    executableVersion: version,
    selection: "explicit_agent_browser_executable_override",
    reason: "default_agent_browser_browser_launch_timed_out_before_app_navigation",
  };
}

async function main() {
  let secrets = [];
  try {
    const { connectionPath, allowRawDimensionLabel, resumeAfterExistingSubmit } = parseWrapperArgs(process.argv.slice(2));
    const connection = validateSourceCorrectionConnection(connectionPath);
    secrets = [connection.userPassword, connection.adminPassword];
    const browserRuntime = inspectExplicitChromium();
    const explicitSpawn = createExplicitChromiumSpawn();
    const sessionPrefix = `cunote-source-correction-explicit-${process.pid}`;
    const receipt = await runSourceCorrectionAcceptance(connection, {
      sessionPrefix,
      spawnSyncImpl: explicitSpawn,
      allowRawDimensionLabel,
      resumeAfterExistingSubmit,
      makeSession: (role, url, password) => createAgentBrowserSession({
        session: `${sessionPrefix}-${role}`,
        webUrl: url,
        sensitiveValues: [password],
        spawnSyncImpl: explicitSpawn,
      }),
    });
    const wrapperPath = fileURLToPath(import.meta.url);
    const finalReceipt = {
      ...receipt,
      sourceProvenance: {
        ...receipt.sourceProvenance,
        executionWrapperRawSha256: createHash("sha256").update(readFileSync(wrapperPath)).digest("hex"),
        executionWrapperOutsideFrozenSnapshot: true,
        sourceCorrectionBrowserToolOutsideFrozenSnapshot: true,
      },
      browserRuntime,
      acceptanceDisposition: allowRawDimensionLabel || resumeAfterExistingSubmit
        ? "diagnostic_not_final_due_nonfresh_runtime"
        : "final_acceptance_candidate",
      evidenceBoundaries: {
        ...receipt.evidenceBoundaries,
        browserExecutableOverride: "explicit_local_headless_shell_due_default_launch_timeout",
      },
    };
    const receiptPath = join(
      connection.runtimeRoot,
      allowRawDimensionLabel || resumeAfterExistingSubmit ? DIAGNOSTIC_RECEIPT : OUTPUT_RECEIPT,
    );
    writeFileSync(receiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({
      ok: true,
      suite: "source-correction-browser-explicit-chromium",
      status: finalReceipt.status,
      acceptanceDisposition: finalReceipt.acceptanceDisposition,
      receiptPath,
      browserRuntime,
      checks: {
        sameObservationBlocked: finalReceipt.workflow.blockedVerify.status,
        sameRowUpdated: finalReceipt.workflow.simulatedUpdate.sameRowUpdated,
        resolved: finalReceipt.workflow.resolved.status,
        rematchedEligibility: finalReceipt.workflow.rematched.eligibility,
      },
      modelCalls: 0,
      externalWrites: 0,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      suite: "source-correction-browser-explicit-chromium",
      error: redact(error instanceof Error ? error.message : error, secrets),
    }));
    process.exitCode = 1;
  }
}

function parseWrapperArgs(args) {
  const diagnostic = args.includes("--diagnostic-allow-raw-label");
  const resumeAfterExistingSubmit = args.includes("--diagnostic-resume-after-submit");
  const connectionArgs = args.filter((argument) =>
    argument !== "--diagnostic-allow-raw-label" && argument !== "--diagnostic-resume-after-submit");
  const { connectionPath } = parseSourceCorrectionBrowserArgs(connectionArgs);
  return { connectionPath, allowRawDimensionLabel: diagnostic, resumeAfterExistingSubmit };
}

function redact(value, secrets) {
  let output = String(value);
  for (const secret of secrets) output = output.split(secret).join("[redacted]");
  return output;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();

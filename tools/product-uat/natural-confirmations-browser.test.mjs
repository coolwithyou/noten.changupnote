import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentBrowserSession,
  nextCompanyIsolationOptionValue,
  parseNaturalConfirmationArgs,
  validateNaturalConfirmationConnection,
} from "./natural-confirmations-browser.mjs";

const runRoot = mkdtempSync(join(tmpdir(), "cunote-product-uat-pg-"));
const sourceRunRoot = mkdtempSync(join(tmpdir(), "cunote-product-uat-source-"));
const snapshotRoot = join(sourceRunRoot, "source");
mkdirSync(snapshotRoot, { mode: 0o700 });
const markerPath = join(runRoot, ".cunote-product-uat-owner.json");
const sourceMarkerPath = join(sourceRunRoot, ".cunote-product-uat-owner.json");
const fixtureReceiptPath = join(runRoot, "confirmation-fixture-receipt.json");
const connectionPath = join(runRoot, "connection.json");
const sourceManifestPath = join(sourceRunRoot, "source-manifest.json");
const sourceFixturePath = join(snapshotRoot, "fixture.txt");
const adminNextEnvPath = join(snapshotRoot, "apps/admin/next-env.d.ts");
const webNextEnvPath = join(snapshotRoot, "apps/web/next-env.d.ts");
const password = "private-browser-password-123456789";
const grantId = "40000000-0000-4000-8000-000000000001";
const servingGrantId = "40000000-0000-4000-8000-000000000002";

const marker = {
  schema: "cunote-product-uat-runtime-owner-v1",
  id: "70000000-0000-4000-8000-000000000001",
};
const nextDevelopmentDeclaration = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/dev/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;
const nextProductionDeclaration = nextDevelopmentDeclaration.replace("./.next/dev/types/routes.d.ts", "./.next/types/routes.d.ts");
const sourceFiles = [
  { path: "apps/admin/next-env.d.ts", sha256: sha256(nextDevelopmentDeclaration) },
  { path: "apps/web/next-env.d.ts", sha256: sha256(nextDevelopmentDeclaration) },
  { path: "fixture.txt", sha256: sha256("bounded source\n") },
];
const sourceManifestSha256 = sha256(JSON.stringify(sourceFiles));
const sourceManifest = {
  schema: "cunote-local-product-uat-source-manifest-v1",
  sourceRoot: "/not-used-by-browser-guard",
  snapshotRoot,
  sha256: sourceManifestSha256,
  files: sourceFiles,
};
const fixtureReceipt = {
  schema: "cunote-local-product-uat-confirmation-fixture-receipt-v1",
  grantId,
  servingGrantId,
  publicationAuthority: "isolated_publisher_fixture_not_release_approval",
  finalState: { activePrompts: ["기존 제외 질문", "최초 필수 질문"] },
  naturalUiReadiness: {
    requiredOtherCompanyA: { naturalCtaContractReady: true },
  },
};
const validConnection = {
  schema: "cunote-local-product-uat-connection-v1",
  holdUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  webUrl: "http://127.0.0.1:43210",
  userPassword: password,
  users: ["sw@noten.im", "dev@noten.im", "guest@noten.im"],
  postgresSocketPath: runRoot,
  snapshotRoot,
  sourceManifestPath,
  sourceManifestSha256,
  confirmationFixtureReceiptPath: fixtureReceiptPath,
  syntheticGrantId: grantId,
  syntheticServingGrantId: servingGrantId,
};

try {
  writePrivateJson(markerPath, marker);
  writePrivateJson(sourceMarkerPath, marker);
  mkdirSync(join(snapshotRoot, "apps/admin"), { recursive: true });
  mkdirSync(join(snapshotRoot, "apps/web"), { recursive: true });
  writeFileSync(adminNextEnvPath, nextProductionDeclaration);
  writeFileSync(webNextEnvPath, nextProductionDeclaration);
  writeFileSync(sourceFixturePath, "bounded source\n");
  writePrivateJson(sourceManifestPath, sourceManifest);
  writePrivateJson(fixtureReceiptPath, fixtureReceipt);
  writePrivateJson(connectionPath, validConnection);

  assert.deepEqual(parseNaturalConfirmationArgs([`--connection=${connectionPath}`]), { connectionPath });
  assert.throws(() => parseNaturalConfirmationArgs([]), /--connection/);
  assert.throws(() => parseNaturalConfirmationArgs([connectionPath]), /--connection/);
  assert.throws(() => parseNaturalConfirmationArgs([`--connection=${connectionPath}`, "extra"]), /하나가 필요/);

  const validated = validateNaturalConfirmationConnection(connectionPath);
  assert.equal(validated.runtimeRoot, realpathSync(runRoot));
  assert.equal(validated.webUrl, "http://127.0.0.1:43210");
  assert.equal(validated.userPassword, password);
  assert.equal(validated.source.manifestSha256, sourceManifestSha256);
  assert.equal(validated.source.fileCount, 3);
  assert.deepEqual(
    validated.source.generatedDeclarations.map((entry) => entry.path).sort(),
    ["apps/admin/next-env.d.ts", "apps/web/next-env.d.ts"],
  );
  assert.ok(validated.source.generatedDeclarations.every((entry) =>
    entry.manifestSha256 !== entry.currentSha256 && entry.exactTemplateVerified));
  assert.match(validated.provenance.connectionRawSha256, /^[a-f0-9]{64}$/);
  assert.match(validated.provenance.browserToolRawSha256, /^[a-f0-9]{64}$/);

  chmodSync(connectionPath, 0o644);
  assert.throws(() => validateNaturalConfirmationConnection(connectionPath), /0600/);
  chmodSync(connectionPath, 0o600);

  writePrivateJson(connectionPath, { ...validConnection, webUrl: "https://example.com" }, false);
  assert.throws(() => validateNaturalConfirmationConnection(connectionPath), /loopback HTTP|127\.0\.0\.1/);
  writePrivateJson(connectionPath, { ...validConnection, holdUntil: new Date(Date.now() + 30_000).toISOString() }, false);
  assert.throws(() => validateNaturalConfirmationConnection(connectionPath), /120초/);

  const linkedFixturePath = join(runRoot, "linked-fixture-receipt.json");
  symlinkSync(fixtureReceiptPath, linkedFixturePath);
  writePrivateJson(connectionPath, { ...validConnection, confirmationFixtureReceiptPath: linkedFixturePath }, false);
  assert.throws(() => validateNaturalConfirmationConnection(connectionPath), /실제 일반 파일/);
  writePrivateJson(connectionPath, validConnection, false);

  writePrivateJson(markerPath, { ...marker, schema: "wrong-owner" }, false);
  assert.throws(() => validateNaturalConfirmationConnection(connectionPath), /owner marker schema/);
  writePrivateJson(markerPath, marker, false);
  assert.equal(validateNaturalConfirmationConnection(connectionPath).grantId, grantId);

  writeFileSync(sourceFixturePath, "drifted source\n");
  assert.throws(() => validateNaturalConfirmationConnection(connectionPath), /snapshot source SHA/);
  writeFileSync(sourceFixturePath, "bounded source\n");

  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return {
      status: 0,
      stdout: JSON.stringify({ success: true, data: { result: true } }),
      stderr: "",
    };
  };
  const browser = createAgentBrowserSession({
    session: "cunote-natural-confirmations-test-owner",
    webUrl: validConnection.webUrl,
    sensitiveValues: [password],
    spawnSyncImpl: fakeSpawn,
  });
  browser.evaluate(`window.__private = ${JSON.stringify(password)}; true`);
  browser.snapshot();
  browser.close();
  assert.ok(calls.length === 3);
  assert.ok(calls.every((call) => call.command === "agent-browser"));
  assert.ok(calls.every((call) => call.args[0] === "--session"));
  assert.ok(calls.every((call) => call.args[1] === "cunote-natural-confirmations-test-owner"));
  assert.ok(calls.every((call) => call.args[2] === "--json"));
  assert.ok(calls.every((call) => call.args.every((arg) => !String(arg).includes(password))));
  assert.ok(calls[0].input.includes(password), "비밀번호는 eval stdin으로만 전달합니다.");

  const failingBrowser = createAgentBrowserSession({
    session: "cunote-natural-confirmations-test-redaction",
    webUrl: validConnection.webUrl,
    sensitiveValues: [password],
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: `failure ${password}` }),
  });
  assert.throws(
    () => failingBrowser.snapshot(),
    (error) => error instanceof Error && error.message.includes("[redacted]") && !error.message.includes(password),
  );

  const nullBrowser = createAgentBrowserSession({
    session: "cunote-natural-confirmations-test-null",
    webUrl: validConnection.webUrl,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify({ success: true, data: { result: null, lifecycle: { reused: true } } }),
      stderr: "",
    }),
  });
  assert.equal(nullBrowser.evaluate("null"), null, "실제 null eval result를 lifecycle wrapper로 바꾸면 안 됩니다.");
  assert.equal(nextCompanyIsolationOptionValue(null), "yes");
  assert.equal(nextCompanyIsolationOptionValue({ values: ["yes"] }), "unknown");
  assert.equal(nextCompanyIsolationOptionValue({ values: ["unknown"] }), "yes");

  console.log(JSON.stringify({
    ok: true,
    suite: "natural-confirmations-browser-guards",
    checks: 31,
    connectionMode: "0600",
    runtimeMode: "0700",
    browserSession: "named_only",
    credentialsTransport: "eval_stdin_only",
  }));
} finally {
  rmSync(runRoot, { recursive: true, force: true });
  rmSync(sourceRunRoot, { recursive: true, force: true });
}

function writePrivateJson(path, value, exclusive = true) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    ...(exclusive ? { flag: "wx" } : {}),
    mode: 0o600,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

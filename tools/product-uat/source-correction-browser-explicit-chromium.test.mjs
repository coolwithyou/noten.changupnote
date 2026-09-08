import assert from "node:assert/strict";
import {
  createExplicitChromiumSpawn,
  EXPLICIT_CHROMIUM_PATH,
  inspectExplicitChromium,
} from "./source-correction-browser-explicit-chromium.mjs";

const calls = [];
const fakeSpawn = (command, args, options) => {
  calls.push({ command, args, options });
  return { status: 0, stdout: "HeadlessChrome 123.4.5\n", stderr: "" };
};
const wrapped = createExplicitChromiumSpawn(fakeSpawn);
wrapped("agent-browser", ["--session", "named", "--json", "open", "about:blank"], { encoding: "utf8" });
wrapped("pnpm", ["exec", "fixture"], { encoding: "utf8" });
assert.deepEqual(calls[0].args, [
  "--executable-path", EXPLICIT_CHROMIUM_PATH,
  "--session", "named", "--json", "open", "about:blank",
]);
assert.deepEqual(calls[1].args, ["exec", "fixture"], "fixture command에는 browser 인자를 넣지 않습니다");
assert.equal(calls[0].args.includes("password"), false);

const fixtureExecutablePath = "/private/tmp/cunote-fixture-headless-shell";
const fixtureExecutable = Buffer.from("portable-fixture-headless-shell");
const runtime = inspectExplicitChromium({
  expectedPath: fixtureExecutablePath,
  realpathSyncImpl: (path) => path,
  lstatSyncImpl: () => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100700,
    uid: 501,
  }),
  readFileSyncImpl: () => fixtureExecutable,
  spawnSyncImpl: fakeSpawn,
  getuidImpl: () => 501,
});
assert.equal(runtime.executablePath, fixtureExecutablePath);
assert.equal(runtime.executableSha256, "7ac0f92616ee793ccee7a587aef508a650955ba73b29f99b0dd38080cc5b37ad");
assert.match(runtime.executableVersion, /HeadlessChrome|Chromium|Chrome/i);
assert.equal(runtime.selection, "explicit_agent_browser_executable_override");

console.log(JSON.stringify({
  ok: true,
  suite: "source-correction-browser-explicit-chromium-wrapper",
  checks: 8,
  selection: runtime.selection,
}));

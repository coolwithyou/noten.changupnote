import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAnalysisLabEnv } from "./loadMonorepoEnv";

const originalCwd = process.cwd();
const original = {
  transport: process.env.ANALYSIS_LAB_TRANSPORT,
  model: process.env.ANALYSIS_LAB_MODEL,
  artifactHmacKey: process.env.ANALYSIS_LAB_ARTIFACT_HMAC_KEY,
  apiKey: process.env.ANTHROPIC_API_KEY,
};
const root = mkdtempSync(join(tmpdir(), "cunote-analysis-env-"));

try {
  mkdirSync(join(root, "apps/web"), { recursive: true });
  writeFileSync(
    join(root, "apps/web/.env.development.local"),
    `ANALYSIS_LAB_TRANSPORT=claude-cli\nANALYSIS_LAB_MODEL=claude-opus-5\nANALYSIS_LAB_ARTIFACT_HMAC_KEY=${"a".repeat(64)}\n`,
  );
  writeFileSync(join(root, ".env"), "ANALYSIS_LAB_TRANSPORT=api\nANTHROPIC_API_KEY=test-key\n");
  process.chdir(root);
  delete process.env.ANALYSIS_LAB_TRANSPORT;
  delete process.env.ANALYSIS_LAB_MODEL;
  delete process.env.ANALYSIS_LAB_ARTIFACT_HMAC_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  loadAnalysisLabEnv();

  assert.equal(process.env.ANALYSIS_LAB_TRANSPORT, "claude-cli");
  assert.equal(process.env.ANALYSIS_LAB_MODEL, "claude-opus-5");
  assert.equal(process.env.ANALYSIS_LAB_ARTIFACT_HMAC_KEY, "a".repeat(64));
  assert.equal(process.env.ANTHROPIC_API_KEY, "test-key");

  process.env.ANALYSIS_LAB_TRANSPORT = "api";
  loadAnalysisLabEnv();
  assert.equal(process.env.ANALYSIS_LAB_TRANSPORT, "api", "명시 셸 환경은 파일보다 우선해야 한다");
} finally {
  process.chdir(originalCwd);
  restore("ANALYSIS_LAB_TRANSPORT", original.transport);
  restore("ANALYSIS_LAB_MODEL", original.model);
  restore("ANALYSIS_LAB_ARTIFACT_HMAC_KEY", original.artifactHmacKey);
  restore("ANTHROPIC_API_KEY", original.apiKey);
  rmSync(root, { recursive: true, force: true });
}

console.log("analysis lab env loader tests: ok");

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

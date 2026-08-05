import assert from "node:assert/strict";
import { buildLabApplicationRoundtripOptions } from "./lab-runner";

const original = {
  model: process.env.ANALYSIS_LAB_MODEL,
  roundtripModel: process.env.ANALYSIS_LAB_ROUNDTRIP_MODEL,
  timeout: process.env.ANALYSIS_LAB_TIMEOUT_MS,
};

try {
  process.env.ANALYSIS_LAB_MODEL = "claude-opus-5";
  delete process.env.ANALYSIS_LAB_ROUNDTRIP_MODEL;
  process.env.ANALYSIS_LAB_TIMEOUT_MS = "900000";
  const fetchImpl = (async () => new Response()) as typeof fetch;
  const options = buildLabApplicationRoundtripOptions({
    transport: "claude-cli",
    apiKey: "subscription",
    fetchImpl,
  });
  assert.equal(options.transport, "claude-cli");
  assert.equal(options.apiKey, "subscription");
  assert.equal(options.fetchImpl, fetchImpl);
  assert.equal(options.model, "claude-opus-5");
  assert.equal(options.timeoutMs, 900_000);
  assert.equal(options.candidateConcurrency, 1);
} finally {
  restore("ANALYSIS_LAB_MODEL", original.model);
  restore("ANALYSIS_LAB_ROUNDTRIP_MODEL", original.roundtripModel);
  restore("ANALYSIS_LAB_TIMEOUT_MS", original.timeout);
}

console.log("application roundtrip lab runner tests: ok");

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

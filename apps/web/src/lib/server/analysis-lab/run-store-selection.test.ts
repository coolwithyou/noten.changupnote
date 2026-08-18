import assert from "node:assert/strict";
import type { LabRun } from "@/lib/server/analysis-lab/lab-contract";
import { selectLatestLabRunForPrompt } from "./run-store";

function run(
  runId: string,
  startedAt: string,
  outcome: "publishable" | "held" | "failed",
): LabRun {
  return {
    runId,
    grantId: "grant-1",
    promptVersion: "lab-deep-v17",
    startedAt,
    primaryValidationOutcome: outcome === "failed" ? "publishable" : outcome,
    error: outcome === "failed" ? "provider timeout" : null,
  } as unknown as LabRun;
}

const publishable = run("run-publishable", "2026-08-14T00:00:00.000Z", "publishable");
const held = run("run-held", "2026-08-14T00:01:00.000Z", "held");
const laterFailure = run("run-failed", "2026-08-14T00:02:00.000Z", "failed");
const runs = [laterFailure, publishable, held];

assert.equal(
  selectLatestLabRunForPrompt(runs, "lab-deep-v17", "terminal")?.runId,
  held.runId,
  "나중 provider 실패가 직전 held terminal을 가리지 않는다",
);
assert.equal(
  selectLatestLabRunForPrompt(runs, "lab-deep-v17", "publishable")?.runId,
  publishable.runId,
  "publishable 인덱스는 held·failed를 제외한다",
);
assert.equal(
  selectLatestLabRunForPrompt(runs, "lab-deep-v16", "terminal"),
  null,
  "promptVersion 경계를 넘지 않는다",
);

console.log("✅ 런 인덱스 — 최신 terminal·publishable 선택·실패 가림 방지");

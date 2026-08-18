import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readLatestLaunchMonitoring } from "./analysisMonitoring"

const root = await mkdtemp(join(tmpdir(), "cunote-analysis-monitoring-"))
try {
  const launchRoot = join(root, "spike-out", "analysis-lab", "launch")
  const manifest = {
    schema: "analysis-launch-manifest-v1",
    preparedAt: "2026-08-18T00:00:00.000Z",
    source: { seriesId: "deep-v24" },
    execution: {
      model: "claude-opus-5",
      concurrency: 2,
      withApplicationRoundtrip: true,
    },
    targets: [{
      sequence: 0,
      grantId: "00000000-0000-4000-8000-000000000000",
      stratum: "kstartup/thin",
    }],
  }
  const manifestSha256 = await writeImmutable(launchRoot, "manifests", manifest)
  const grant = {
    schema: "analysis-launch-grant-v1",
    manifestSha256,
    approvedAt: "2026-08-18T00:01:00.000Z",
  }
  const grantSha256 = await writeImmutable(launchRoot, "grants", grant)
  const receipt = {
    schema: "analysis-launch-receipt-v1",
    manifestSha256,
    grantSha256,
    startedAt: "2026-08-18T00:02:00.000Z",
    finishedAt: "2026-08-18T00:03:00.000Z",
    stopReason: "completed",
    systemicFailure: null,
    targets: [{
      sequence: 0,
      grantId: manifest.targets[0]!.grantId,
      status: "publishable",
      applicationRoundtripStatus: "complete",
      error: null,
    }],
  }
  const receiptSha256 = await writeImmutable(launchRoot, "receipts", receipt)

  const finished = await readLatestLaunchMonitoring(root)
  assert.equal(finished.state, "finished")
  assert.equal(finished.receiptSha256, receiptSha256)
  assert.equal(finished.summary.publishable, 1)
  assert.equal(finished.targets[0]!.stratum, "kstartup/thin")

  const status = {
    schema: "analysis-launch-status-v1",
    authority: "derived-monitoring-projection",
    grantSha256,
    manifestSha256,
    seriesId: "deep-v24",
    lifecycle: "running",
    startedAt: "2026-08-18T00:04:00.000Z",
    updatedAt: "2026-08-18T00:05:00.000Z",
    finishedAt: null,
    receiptSha256: null,
    stopReason: null,
    systemicFailure: null,
    targets: [{
      sequence: 0,
      grantId: manifest.targets[0]!.grantId,
      stratum: "kstartup/thin",
      status: "running",
      startedAt: "2026-08-18T00:04:00.000Z",
      finishedAt: null,
      title: null,
      applicationRoundtripStatus: null,
      error: null,
    }],
  }
  await mkdir(join(launchRoot, "status"), { recursive: true })
  await writeFile(join(launchRoot, "status", `${grantSha256}.json`), JSON.stringify(status))

  const running = await readLatestLaunchMonitoring(root)
  assert.equal(running.state, "running")
  assert.equal(running.summary.running, 1)
  assert.equal(running.receiptSha256, null)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("analysisMonitoring.test.ts: all assertions passed")

async function writeImmutable(
  launchRoot: string,
  kind: "manifests" | "grants" | "receipts",
  value: unknown,
): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value))
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const directory = join(launchRoot, kind)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${sha256}.json`), bytes)
  return sha256
}

#!/usr/bin/env node
// The queue owns each work directory until all uploads finish. Cloud Run's
// temporary filesystem uses instance memory, so every terminal path cleans it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversionQueue } from "../dist/queue.js";
import { synthMultiPagePdf, synthUnsupported } from "./failure-fixtures.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "cunote-queue-cleanup-test."));
const originalTmpDir = process.env.TMPDIR;
process.env.TMPDIR = testRoot;

const storage = {
  async putObject({ key }) {
    assert.ok(readdirSync(testRoot).length > 0, "work directory must survive upload");
    return { key, url: `stub://${key}` };
  },
  async getObjectText() { return ""; },
  publicUrl(key) { return `stub://${key}`; },
};

async function runCase(label, body, filename, store = storage) {
  const queue = new ConversionQueue({ storage: store, fetchSource: async () => body });
  queue.enqueue({
    jobId: label,
    source: "kstartup",
    sourceId: label,
    filename,
    sourceObjectUrl: `stub://${label}`,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  await queue.drain();
  assert.deepEqual(readdirSync(testRoot), [], `${label}: temporary files leaked`);
  return queue.get(label);
}

try {
  assert.equal(tmpdir(), testRoot);

  const good = await runCase("uploaded", synthMultiPagePdf(), "sample.pdf");
  assert.ok(["succeeded", "partial"].includes(good.status));
  assert.ok(good.artifacts.length > 0, "uploaded artifacts remain in job record");

  const rejected = await runCase("unsupported", synthUnsupported(), "note.txt");
  assert.equal(rejected.status, "failed");

  const failedUpload = await runCase("upload-error", synthMultiPagePdf(), "sample.pdf", {
    ...storage,
    async putObject() { throw new Error("simulated storage failure"); },
  });
  assert.equal(failedUpload.status, "failed");
  assert.match(failedUpload.error, /simulated storage failure/);

  console.log("conversion queue work directory cleanup: PASS (success, conversion failure, upload failure)");
} finally {
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  rmSync(testRoot, { recursive: true, force: true });
}

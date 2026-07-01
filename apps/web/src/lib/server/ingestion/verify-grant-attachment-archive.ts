import assert from "node:assert/strict";
import { detectHwpMarkdownConverter, isHwpFilename } from "@cunote/core/bizinfo/hwp-markdown";
import { archiveGrantAttachments } from "./grantAttachmentArchive";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";

class MemoryObjectStorage implements R2ObjectStorage {
  objects: Array<{ key: string; body: Buffer | string; contentType: string }> = [];

  async getObjectText(key: string) {
    const object = this.objects.find((item) => item.key === key);
    return object ? object.body.toString() : "";
  }

  async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
    this.objects.push(input);
    return {
      key: input.key,
      url: this.publicUrl(input.key),
    };
  }

  publicUrl(key: string): string {
    return `https://r2.example/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  }
}

const storage = new MemoryObjectStorage();
const result = await archiveGrantAttachments([{
  filename: "사업계획서.pdf",
  url: "https://example.test/plan.pdf",
}], {
  source: "bizinfo",
  sourceId: "PBLN_VERIFY",
  collectedAt: new Date("2026-06-27T00:00:00.000Z"),
  enabled: true,
  convertHwp: true,
  autoInstallPyhwp: false,
  allowFailures: false,
  storage,
  fetchImpl: async () => new Response(Buffer.from("pdf-body"), {
    status: 200,
    headers: { "content-type": "application/pdf" },
  }),
});

assert.equal(result.archivedCount, 1);
assert.equal(result.convertedCount, 0);
assert.equal(result.skippedConversionCount, 1);
assert.equal(result.failureCount, 0);
assert.equal(result.attachments[0]?.filename, "사업계획서.pdf");
assert.equal(result.attachments[0]?.source_uri, "https://example.test/plan.pdf");
assert.match(result.attachments[0]?.archive_url ?? "", /^https:\/\/r2\.example\/grant-archive\/bizinfo\/PBLN_VERIFY\/attachments\//);
assert.equal(result.attachments[0]?.url, result.attachments[0]?.archive_url);
assert.equal(result.attachments[0]?.content_type, "application/pdf");
assert.equal(result.attachments[0]?.bytes, Buffer.byteLength("pdf-body"));
assert.equal(result.attachments[0]?.conversion?.status, "skipped");
assert.equal(storage.objects.length, 1);
assert.equal(isHwpFilename("모집공고.hwp"), true);
assert.equal(isHwpFilename("모집공고.pdf"), false);

const passthrough = await archiveGrantAttachments([{
  filename: "원본.hwp",
  url: "https://example.test/original.hwp",
}], {
  source: "bizinfo",
  sourceId: "PBLN_PASS",
  collectedAt: new Date("2026-06-27T00:00:00.000Z"),
  enabled: false,
  convertHwp: true,
  autoInstallPyhwp: false,
  allowFailures: false,
  storage: null,
});
assert.equal(passthrough.archivedCount, 0);
assert.equal(passthrough.attachments[0]?.url, "https://example.test/original.hwp");

const hwpConverterStatus = detectHwpMarkdownConverter({ autoInstallPyhwp: false });
assert.equal(typeof hwpConverterStatus.available, "boolean");
assert.ok(hwpConverterStatus.description.length > 0);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "attachment_r2_archive_metadata",
    "attachment_passthrough_when_disabled",
    "hwp_filename_detection",
    "hwp_converter_status_probe",
  ],
  archived: {
    count: result.archivedCount,
    storageKey: result.attachments[0]?.storage_key,
    archiveUrl: result.attachments[0]?.archive_url,
  },
  hwpConverterStatus: {
    available: hwpConverterStatus.available,
    description: hwpConverterStatus.description,
    error: hwpConverterStatus.error ? hwpConverterStatus.error.split("\n")[0] : null,
  },
}, null, 2));

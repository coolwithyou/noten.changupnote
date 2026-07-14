import assert from "node:assert/strict";
import { buildBizInfoProgramExtractionInput } from "@cunote/core";
import { buildBizInfoSampleEntries } from "./bizinfoSample";
import { hashGrantRawPayload } from "./grantRawHash";
import { needsBizInfoAttachmentArchive } from "./archiveBizInfoCore";
import {
  planGrantArchivePublication,
  selectPublishableArchiveEntries,
  type ExistingGrantRawHash,
} from "./archivePlan";

const entries = buildBizInfoSampleEntries({
  asOf: new Date("2026-06-26T00:00:00.000+09:00"),
  collectedAt: new Date("2026-06-26T00:00:00.000+09:00"),
});
assert.equal(entries.length, 1);
const [entry] = entries;
assert.ok(entry);

const unchanged: ExistingGrantRawHash[] = [{
  sourceId: entry.raw.source_id,
  rawHash: hashGrantRawPayload(entry.raw.payload),
}];
const changed: ExistingGrantRawHash[] = [{
  sourceId: entry.raw.source_id,
  rawHash: "stale-hash",
}];

const unchangedPlan = planGrantArchivePublication("bizinfo", entries, unchanged, { skipUnchanged: true });
const changedPlan = planGrantArchivePublication("bizinfo", entries, changed, { skipUnchanged: true });
const fullPlan = planGrantArchivePublication("bizinfo", entries, unchanged, { skipUnchanged: false });

assert.equal(unchangedPlan.publishableCount, 0);
assert.equal(unchangedPlan.unchangedCount, 1);
assert.equal(selectPublishableArchiveEntries(entries, unchangedPlan).length, 0);
assert.equal(changedPlan.changedCount, 1);
assert.equal(changedPlan.publishableCount, 1);
assert.equal(fullPlan.publishableCount, 1);

const sourceAttachment = buildBizInfoProgramExtractionInput(entry.raw.payload).metadata.attachments[0];
assert.ok(sourceAttachment?.url);
const sourceOnlyState = {
  sourceId: entry.raw.source_id,
  rawHash: unchanged[0]?.rawHash ?? "",
  attachments: [{
    filename: sourceAttachment.filename,
    url: sourceAttachment.url,
    // 과거 버그가 원본 URL을 archive_url로 복제해도 완료로 보면 안 된다.
    archive_url: sourceAttachment.url,
  }],
};
assert.equal(needsBizInfoAttachmentArchive(entry.raw.payload, sourceOnlyState), true);
assert.equal(needsBizInfoAttachmentArchive(entry.raw.payload, {
  ...sourceOnlyState,
  attachments: [{
    filename: sourceAttachment.filename,
    source_uri: sourceAttachment.url,
    archive_url: "https://r2.example/archive.hwp",
    storage_key: "grant-archive/bizinfo/PBLN_SAMPLE/archive.hwp",
    sha256: "abc123",
  }],
}), false);
assert.equal(needsBizInfoAttachmentArchive(entry.raw.payload, {
  ...sourceOnlyState,
  attachments: [{
    filename: sourceAttachment.filename,
    source_uri: sourceAttachment.url,
    storage_key: "grant-archive/bizinfo/PBLN_SAMPLE/archive.hwp",
  }],
}), true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "bizinfo_archive_unchanged_skip",
    "bizinfo_archive_changed_publishable",
    "bizinfo_archive_publish_unchanged_override",
    "bizinfo_attachment_refresh_requires_storage_key_and_sha256",
  ],
  unchangedPlan: {
    unchangedCount: unchangedPlan.unchangedCount,
    publishableCount: unchangedPlan.publishableCount,
  },
  changedPlan: {
    changedCount: changedPlan.changedCount,
    publishableCount: changedPlan.publishableCount,
  },
}, null, 2));

import assert from "node:assert/strict";
import {
  mergeKStartupAttachmentArchiveRecoveryRows,
  planKStartupAttachmentArchiveBatch,
  type KStartupAttachmentArchiveEntry,
} from "./kstartupAttachmentArchiveBatch";

const priority = entry("new", [
  attachment("신청서.hwpx", "new-form"),
  { ...attachment("공고문.pdf", "new-notice"), storage_key: "partial-without-sha" },
]);
const backlog = entry("backlog", [
  attachment("공고문.pdf", "old-notice"),
  attachment("사업계획서.hwp", "old-plan"),
], [{ operator: "text_only", kind: "required" }]);
const complete = entry("complete", [{
  ...attachment("완료서식.hwp", "complete"),
  storage_key: "grant-archive/complete.hwp",
  sha256: "done",
}]);

const plan = planKStartupAttachmentArchiveBatch([backlog, complete, priority], {
  prioritySourceIds: ["new"],
  maxGrants: 2,
  maxTotalAttachments: 3,
  maxAttachmentsPerGrant: 2,
});
assert.equal(plan.totalCandidateCount, 2, "storage_key+sha256가 모두 있는 첨부는 후보가 아니다");
assert.equal(plan.candidates.length, 2);
assert.equal(plan.selectedAttachmentCount, 3, "전역 attachment cap을 넘으면 안 된다");
assert.equal(plan.candidates[0]?.entry.grant.source_id, "new", "신규/변경 sourceId가 backlog보다 우선이다");
assert.equal(plan.candidates[0]?.selected.length, 2);
assert.equal(plan.candidates[1]?.selected.length, 1);

const empty = planKStartupAttachmentArchiveBatch([priority], {
  maxGrants: 4,
  maxTotalAttachments: 0,
  maxAttachmentsPerGrant: 2,
});
assert.equal(empty.candidates.length, 0);
assert.equal(empty.selectedAttachmentCount, 0);

const recovered = mergeKStartupAttachmentArchiveRecoveryRows([entry("closed", [])], [{
  sourceId: "closed",
  filename: "마감 공고문.hwp",
  sourceUri: "https://origin.example/closed-notice",
  archiveUrl: null,
  storageKey: null,
  contentType: null,
  bytes: null,
  sha256: null,
  fetchedAt: null,
  conversionStatus: null,
  markdownUrl: null,
  markdownStorageKey: null,
  markdownSha256: null,
  markdownBytes: null,
  converter: null,
  convertedAt: null,
  conversionError: null,
}]);
const recoveredPlan = planKStartupAttachmentArchiveBatch(recovered, {
  sourceIds: ["closed"],
  maxGrants: 1,
  maxTotalAttachments: 1,
  maxAttachmentsPerGrant: 1,
});
assert.equal(recoveredPlan.totalCandidateCount, 1, "명시 복구 대상은 archive row의 원본 URL을 되살린다");
assert.equal(recoveredPlan.candidates[0]?.selected[0]?.filename, "마감 공고문.hwp");
assert.equal(recoveredPlan.candidates[0]?.selected[0]?.url, "https://origin.example/closed-notice");

console.log("kstartupAttachmentArchiveBatch.test.ts: all assertions passed");

function entry(
  sourceId: string,
  attachments: KStartupAttachmentArchiveEntry["raw"]["attachments"],
  criteria: Array<{ operator: string; kind: string }> = [],
): KStartupAttachmentArchiveEntry {
  return {
    grant: {
      source: "kstartup",
      source_id: sourceId,
      title: sourceId,
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.5,
    },
    raw: {
      source: "kstartup",
      source_id: sourceId,
      collected_at: "2026-07-15T00:00:00.000Z",
      status: "published",
      payload: { pbanc_sn: sourceId },
      attachments,
    },
    criteria: criteria as KStartupAttachmentArchiveEntry["criteria"],
  } as unknown as KStartupAttachmentArchiveEntry;
}

function attachment(filename: string, id: string) {
  return {
    filename,
    url: `https://origin.example/${id}`,
    source_uri: `https://origin.example/${id}`,
  };
}

import assert from "node:assert/strict";
import type { Grant, NormalizedGrant } from "@cunote/contracts";
import type { BizInfoProgram, KStartupAnnouncement } from "@cunote/core";
import { buildGrantAnalysisPilotInputs } from "./grantAnalysisPilotInputs";

const kstartupEntry: NormalizedGrant<KStartupAnnouncement> = {
  raw: {
    source: "kstartup",
    source_id: "178387",
    raw_hash: "kstartup-revision-1",
    status: "normalized",
    payload: {
      pbanc_sn: 178387,
      biz_pbanc_nm: "AI 창업기업 사업화 지원",
      aply_trgt_ctnt: "서울 소재 창업 7년 이내 기업",
      detail: {
        parser_version: "test",
        fetched_at: "2026-07-15T00:00:00.000Z",
        apply_method_text: "온라인 접수",
        submit_documents_text: "사업계획서",
        attachments: [
          { filename: "모집공고문.pdf", url: "https://example.test/notice" },
          { filename: "신청서.hwp", url: "https://example.test/form" },
          { filename: "깨진첨부.pdf", url: "https://example.test/broken" },
        ],
      },
    },
    attachments: [{
      filename: "모집공고문.pdf",
      storage_key: "raw/notice.pdf",
      sha256: "raw-notice-sha",
      conversion: {
        status: "converted",
        markdown_storage_key: "markdown/notice.md",
        markdown_bytes: 100,
      },
    }, {
      filename: "신청서.hwp",
      storage_key: "raw/form.hwp",
      sha256: "raw-form-sha",
      conversion: {
        status: "converted",
        markdown_storage_key: "markdown/form.md",
        markdown_bytes: 100,
      },
    }, {
      filename: "깨진첨부.pdf",
      storage_key: "raw/broken.pdf",
      sha256: "raw-broken-sha",
      conversion: {
        status: "failed",
        error: "PDF parser failed",
      },
    }],
  },
  grant: grant("kstartup", "178387", "AI 창업기업 사업화 지원"),
  criteria: [],
};

const reads: string[] = [];
const kstartup = await buildGrantAnalysisPilotInputs({
  entry: kstartupEntry,
  storage: {
    async getObjectText(key) {
      reads.push(key);
      if (key === "markdown/form.md") throw new Error("R2 read failed");
      return "지원대상: 서울 소재 창업기업이며 업력 7년 이내";
    },
  },
  limits: {
    maxAttachments: 3,
    maxCharsPerAttachment: 12,
    maxTotalChars: 30,
  },
});

assert.deepEqual(reads, ["markdown/notice.md", "markdown/form.md"]);
assert.equal(kstartup.sourceRevision, "kstartup-revision-1");
assert.equal(kstartup.readOnly, true);
assert.equal(kstartup.externalLlmCalls, 0);
assert.equal(kstartup.attachments.counts.sourceDeclaredExpected, 3);
assert.equal(kstartup.attachments.counts.expected, 3);
assert.equal(kstartup.attachments.counts.fetched, 3);
assert.equal(kstartup.attachments.counts.converted, 2);
assert.equal(kstartup.attachments.counts.loadableConverted, 2);
assert.equal(kstartup.attachments.counts.selectedForLoad, 2);
assert.equal(kstartup.attachments.counts.loaded, 1);
assert.equal(kstartup.attachments.counts.included, 1);
assert.equal(kstartup.attachments.characters.loadedAttachmentMarkdown, 12);
assert.equal(kstartup.attachments.characters.includedAttachmentMarkdown, 11);
assert.equal(kstartup.attachments.truncation.truncatedAttachmentCount, 1);
assert.equal(kstartup.attachments.failures.filter((failure) => failure.stage === "conversion").length, 1);
assert.equal(kstartup.attachments.failures.filter((failure) => failure.stage === "load").length, 1);
assert.doesNotMatch(kstartup.apiOnly.input.text, /모집공고문\.pdf/);
assert.match(kstartup.apiPlusAttachments.input.text, /모집공고문\.pdf/);
assert.notEqual(kstartup.apiOnly.inputSha256, kstartup.apiPlusAttachments.inputSha256);
assert.match(kstartup.apiOnly.inputSha256, /^[a-f0-9]{64}$/);

const noStorage = await buildGrantAnalysisPilotInputs({
  entry: kstartupEntry,
  storage: null,
});
assert.equal(noStorage.attachments.counts.converted, 2);
assert.equal(noStorage.attachments.counts.loaded, 0);
assert.equal(noStorage.attachments.counts.included, 0);
assert.equal(noStorage.attachments.characters.includedAttachmentMarkdown, 0);
assert.equal(noStorage.attachments.failures.filter((failure) => failure.stage === "load").length, 2);
assert.equal(noStorage.apiOnly.inputSha256, noStorage.apiPlusAttachments.inputSha256);
assert.equal(noStorage.apiOnly.input.text, noStorage.apiPlusAttachments.input.text);
assert.ok(noStorage.warnings.includes("converted_attachment_not_fully_included"));

const bizinfoEntry: NormalizedGrant<BizInfoProgram> = {
  raw: {
    source: "bizinfo",
    source_id: "PBLN-1",
    raw_hash: "bizinfo-revision-1",
    status: "normalized",
    payload: {
      pblancId: "PBLN-1",
      pblancNm: "수출기업 지원사업",
      trgetNm: "중소기업",
      bsnsSumryCn: "<p>수출 역량 강화</p>",
      fileNm: "통합공고.pdf",
      flpthNm: "/files/notice.pdf",
    },
    attachments: [{
      filename: "통합공고.pdf",
      storage_key: "raw/bizinfo.pdf",
      sha256: "raw-bizinfo-sha",
      conversion: {
        status: "converted",
        markdown_storage_key: "markdown/bizinfo.md",
        markdown_bytes: 100,
      },
    }],
  },
  grant: grant("bizinfo", "PBLN-1", "수출기업 지원사업"),
  criteria: [],
};

const bizinfo = await buildGrantAnalysisPilotInputs({
  entry: bizinfoEntry,
  storage: { async getObjectText() { return "업력 3년 이내 중소기업"; } },
});
assert.equal(bizinfo.source, "bizinfo");
assert.equal(bizinfo.sourceRevision, "bizinfo-revision-1");
assert.equal(bizinfo.attachments.counts.sourceDeclaredExpected, 1);
assert.equal(bizinfo.attachments.counts.included, 1);
assert.match(bizinfo.apiPlusAttachments.input.text, /통합공고\.pdf/);
assert.match(bizinfo.apiPlusAttachments.input.text, /업력 3년 이내/);

await assert.rejects(
  () => buildGrantAnalysisPilotInputs({
    entry: {
      ...kstartupEntry,
      raw: { ...kstartupEntry.raw, source_id: "wrong-id" },
    },
    storage: null,
  }),
  /source identity mismatch/,
);

await assert.rejects(
  () => buildGrantAnalysisPilotInputs({
    entry: {
      raw: { source: "bizinfo_event", source_id: "event-1", payload: {}, status: "normalized" },
      grant: grant("bizinfo_event", "event-1", "행사"),
      criteria: [],
    },
    storage: null,
  }),
  /Unsupported grant analysis pilot source/,
);

console.log("grantAnalysisPilotInputs.test.ts: all assertions passed");

function grant(source: Grant["source"], sourceId: string, title: string): Grant {
  return {
    source,
    source_id: sourceId,
    title,
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.5,
  };
}

import assert from "node:assert/strict";
import type { BizInfoProgram } from "@cunote/core";
import { recoverBizInfoSourceAttachments } from "./bizinfoAttachmentArchiveBatch";
import { selectKStartupAttachmentsForArchive } from "./kstartupAttachmentSelection";

const applicationUrl = "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_APP&fileSn=0";
const ruleUrl = "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_APP&fileSn=1";
const bodyUrl = "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_BODY&fileSn=0";
const entry = {
  grant: {
    source: "bizinfo",
    source_id: "PBLN_TEST",
    title: "기업마당 본문 복구 테스트",
  },
  raw: {
    source: "bizinfo",
    source_id: "PBLN_TEST",
    payload: {
      pblancId: "PBLN_TEST",
      pblancNm: "기업마당 본문 복구 테스트",
      fileNm: "신청서.hwpx@참가규정.hwpx",
      flpthNm: `${applicationUrl}@${ruleUrl}`,
      printFileNm: "공고문.pdf",
      printFlpthNm: bodyUrl,
    } satisfies BizInfoProgram,
    attachments: [{
      filename: "신청서.hwpx",
      url: "https://archive.example/application",
      source_uri: applicationUrl,
      storage_key: "grant-archive/application",
      sha256: "a".repeat(64),
      conversion: { status: "failed" as const },
    }, {
      filename: "참가규정.hwpx",
      url: "https://archive.example/rule",
      source_uri: ruleUrl,
      storage_key: "grant-archive/rule",
      sha256: "b".repeat(64),
      conversion: {
        status: "converted" as const,
        markdown_storage_key: "grant-archive/rule.md",
        markdown_sha256: "c".repeat(64),
      },
    }],
  },
  criteria: [],
} as never;

const recovered = recoverBizInfoSourceAttachments(entry);
assert.deepEqual(
  recovered.map(({ filename, source_uri, storage_key }) => ({ filename, source_uri, storage_key })),
  [{
    filename: "신청서.hwpx",
    source_uri: applicationUrl,
    storage_key: "grant-archive/application",
  }, {
    filename: "참가규정.hwpx",
    source_uri: ruleUrl,
    storage_key: "grant-archive/rule",
  }, {
    filename: "공고문.pdf",
    source_uri: undefined,
    storage_key: undefined,
  }],
  "현재 raw payload의 본문을 추가하고 기존 exact attachment의 보관 메타데이터를 보존",
);

assert.deepEqual(
  selectKStartupAttachmentsForArchive(recovered, 3).map(({ filename }) => filename),
  ["공고문.pdf"],
  "기본 복구는 아직 보관되지 않은 본문만 선택",
);
assert.deepEqual(
  selectKStartupAttachmentsForArchive(recovered, 3, { reprocessMissingMarkdown: true })
    .map(({ filename }) => filename),
  ["공고문.pdf", "신청서.hwpx"],
  "명시 recovery는 본문과 markdown 실패 신청서를 함께 선택",
);

console.log("bizinfoAttachmentArchiveBatch.test.ts: all assertions passed");

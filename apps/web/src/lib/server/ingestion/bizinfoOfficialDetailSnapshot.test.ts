import assert from "node:assert/strict";
import { buildBizInfoProgramExtractionInput, type BizInfoProgram } from "@cunote/core";
import {
  buildBizInfoOfficialDetailAttachmentSnapshot,
  carryBizInfoOfficialDetailAttachmentSnapshot,
} from "./bizinfoOfficialDetailSnapshot";

const program: BizInfoProgram = {
  pblancId: "PBLN_000000000126284",
  fileNm: "신청서.hwp",
  flpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_FORM&fileSn=1",
  printFileNm: "옛 공고문.hwp",
  printFlpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_MAIN&fileSn=1",
};
const html = `<ul>
  <h3>첨부파일</h3><li><div class="file_name">신청서.hwp</div>
    <a href="/cmm/fms/fileDown.do?atchFileId=FILE_FORM&fileSn=1">다운로드</a></li>
  <h3>본문출력파일</h3><li><div class="file_name">변경 공고문.hwp</div>
    <a href="/cmm/fms/fileDown.do?atchFileId=FILE_MAIN&fileSn=2">다운로드</a></li>
</ul>`;

const snapshot = buildBizInfoOfficialDetailAttachmentSnapshot(program, html);
const reconciled = { ...program, officialDetailAttachmentSnapshot: snapshot };
assert.equal(snapshot.attachments.length, 2);
assert.equal(snapshot.attachments[1]?.kind, "print");
assert.equal(snapshot.attachments[1]?.filename, "변경 공고문.hwp");
assert.deepEqual(buildBizInfoProgramExtractionInput(reconciled).metadata.attachments, [
  { filename: "신청서.hwp",
    url: "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_FORM&fileSn=1" },
  { filename: "변경 공고문.hwp",
    url: "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_MAIN&fileSn=2" },
]);
assert.deepEqual(carryBizInfoOfficialDetailAttachmentSnapshot(program, reconciled), reconciled);
assert.equal(carryBizInfoOfficialDetailAttachmentSnapshot({
  ...program, printFlpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_MAIN&fileSn=2",
}, reconciled).officialDetailAttachmentSnapshot, undefined);
assert.throws(() => buildBizInfoOfficialDetailAttachmentSnapshot(program, "<html>no links</html>"), /incomplete/);

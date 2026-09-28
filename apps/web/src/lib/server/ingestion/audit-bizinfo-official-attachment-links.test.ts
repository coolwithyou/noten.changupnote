import assert from "node:assert/strict";
import {
  attachmentIdentityPairsFromApi,
  attachmentIdentityPairsFromDetail,
  attachmentIdentityPairsFromStored,
  attachmentRowsFromDetail,
  compareBizInfoOfficialAttachmentIdentities,
} from "./audit-bizinfo-official-attachment-links";

const api = attachmentIdentityPairsFromApi({
  printFlpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_MAIN&fileSn=0",
  flpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_FORM&fileSn=0",
});
assert.deepEqual(api, ["FILE_MAIN:0", "FILE_FORM:0"]);

const detail = attachmentIdentityPairsFromDetail(`
  <a href="/cmm/fms/fileDown.do?atchFileId=FILE_FORM&amp;fileSn=1">신청서</a>
  <a href='/cmm/fms/fileDown.do?atchFileId=FILE_MAIN&fileSn=1'>공고문</a>
  <a href="https://elsewhere.invalid/cmm/fms/fileDown.do?atchFileId=FILE_BAD&fileSn=1">제외</a>
`);
assert.deepEqual(detail, ["FILE_FORM:1", "FILE_MAIN:1"]);
assert.deepEqual(api.filter((identity) => !detail.includes(identity)), ["FILE_MAIN:0", "FILE_FORM:0"]);
const stored = attachmentIdentityPairsFromStored([
  { filename: "공고문.hwp", source_uri: "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_MAIN&fileSn=1" },
  { filename: "신청서.hwp", url: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_FORM&fileSn=1" },
  { filename: "보관 원본", source_uri: "https://elsewhere.invalid/cmm/fms/fileDown.do?atchFileId=FILE_BAD&fileSn=1" },
]);
assert.deepEqual(stored, ["FILE_MAIN:1", "FILE_FORM:1"]);
assert.deepEqual(attachmentIdentityPairsFromStored(null), []);
assert.deepEqual(compareBizInfoOfficialAttachmentIdentities({ api, current: stored, detail }), {
  apiMatches: false,
  currentMatches: true,
  apiMissingFromDetail: ["FILE_MAIN:0", "FILE_FORM:0"],
  apiNewOnDetail: ["FILE_FORM:1", "FILE_MAIN:1"],
  currentMissingFromDetail: [],
  currentNewOnDetail: [],
});
assert.deepEqual(compareBizInfoOfficialAttachmentIdentities({
  api: detail, current: ["FILE_FORM:0", "FILE_MAIN:1"], detail,
}).currentMissingFromDetail, ["FILE_FORM:0"]);
assert.deepEqual(attachmentIdentityPairsFromDetail("<html>첨부 형식 변경</html>"), []);
assert.deepEqual(attachmentRowsFromDetail(`
  <ul>
    <h3>첨부파일</h3>
    <li><div class="file_name">참여 신청서&amp;확인서.hwp</div><div class="right_btn">
      <a href="/cmm/fms/fileDown.do?atchFileId=FILE_FORM&amp;fileSn=1">다운로드</a>
    </div></li>
    <h3>본문출력파일</h3>
    <li><div class="file_name">모집공고_변경.hwp</div><div class="right_btn">
      <a href="/cmm/fms/fileDown.do?atchFileId=FILE_MAIN&fileSn=2">다운로드</a>
    </div></li>
  </ul>
`), [
  { kind: "attachment", filename: "참여 신청서&확인서.hwp",
    url: "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_FORM&fileSn=1",
    identity: "FILE_FORM:1" },
  { kind: "print", filename: "모집공고_변경.hwp",
    url: "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_MAIN&fileSn=2",
    identity: "FILE_MAIN:2" },
]);
assert.throws(() => attachmentRowsFromDetail(`
  <h3>본문출력파일</h3><li><div class="file_name">원문.hwp</div>
  <a href="https://elsewhere.invalid/cmm/fms/fileDown.do?atchFileId=FILE_BAD&fileSn=1">다운로드</a></li>
`), /unexpected origin/);
console.log("bizinfo official link identity parsing PASS");

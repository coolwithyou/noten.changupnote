import assert from "node:assert/strict";
import {
  attachmentIdentityPairsFromApi,
  attachmentIdentityPairsFromDetail,
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
assert.deepEqual(attachmentIdentityPairsFromDetail("<html>첨부 형식 변경</html>"), []);
console.log("bizinfo official link identity parsing PASS");

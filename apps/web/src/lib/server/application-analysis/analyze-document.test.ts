import assert from "node:assert/strict";
import { analyzeRoundtripDocument } from "./analyze-document";
import { isEditableRoundtripDocumentFormat } from "./contract";

const REFERENCE_FILENAME = "붙임 3-2. 국가연구개발혁신법(법률).hwp";

let fetchCalls = 0;
let plannerUsageEvents = 0;
const reference = await analyzeRoundtripDocument({
  attachmentId: "reference-hwpml",
  filename: REFERENCE_FILENAME,
  declaredFormat: "hwp",
  sourceSha256: "a".repeat(64),
  body: hwpml("국가연구개발사업 운영 지침 및 법률 안내"),
  apiKey: null,
  transport: "api",
  fetchImpl: async () => {
    fetchCalls += 1;
    throw new Error("참고자료 분류는 모델을 호출하면 안 됩니다.");
  },
  onPlannerUsage: () => {
    plannerUsageEvents += 1;
  },
});

assert.equal(reference.document.detectedFormat, "hwpml");
assert.equal(reference.document.role, "announcement");
assert.equal(reference.document.fieldPlanning.status, "skipped");
assert.equal(reference.document.fields.length, 0, "읽기 전용 HWPML은 쓰기 후보를 노출하지 않는다");
assert.equal(reference.document.recommendedInputFieldCount, 0);
assert.match(reference.document.warnings.join("\n"), /REFERENCE_ONLY_FORMAT/);
assert.match(reference.markdown, /국가연구개발사업 운영 지침/);
assert.equal(fetchCalls, 0);
assert.equal(plannerUsageEvents, 0);

await assert.rejects(
  analyzeRoundtripDocument({
    attachmentId: "application-hwpml",
    filename: "지원사업 신청서.hwp",
    declaredFormat: "hwp",
    sourceSha256: "b".repeat(64),
    body: hwpml("지원사업 신청서 기업명 대표자 사업계획"),
    apiKey: null,
    transport: "api",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("미지원 신청서는 모델을 호출하면 안 됩니다.");
    },
    onPlannerUsage: () => {
      plannerUsageEvents += 1;
    },
  }),
  /HWPML.*신청 양식.*지원하지 않습니다/,
);

await assert.rejects(
  analyzeRoundtripDocument({
    attachmentId: "unknown-hwpml",
    filename: "문서.hwp",
    declaredFormat: "hwp",
    sourceSha256: "c".repeat(64),
    body: hwpml("내용"),
    apiKey: null,
    transport: "api",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("미분류 문서는 모델을 호출하면 안 됩니다.");
    },
    onPlannerUsage: () => {
      plannerUsageEvents += 1;
    },
  }),
  /HWPML.*역할을 확정하지 못했습니다/,
);

await assert.rejects(
  analyzeRoundtripDocument({
    attachmentId: "damaged-hwpml",
    filename: REFERENCE_FILENAME,
    declaredFormat: "hwp",
    sourceSha256: "d".repeat(64),
    body: Buffer.from("<?xml version=\"1.0\"?><HWPML><BODY>"),
    apiKey: null,
    transport: "api",
  }),
  /PARSE_ERROR/,
);

assert.equal(fetchCalls, 0);
assert.equal(plannerUsageEvents, 0);
assert.equal(isEditableRoundtripDocumentFormat("hwp"), true);
assert.equal(isEditableRoundtripDocumentFormat("hwpx"), true);
assert.equal(isEditableRoundtripDocumentFormat("hwpml"), false, "HWPML을 native writer 형식으로 승격하지 않는다");

console.log("application document HWPML boundary tests: ok");

function hwpml(text: string): Uint8Array {
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>`
      + `<HWPML Version="2.1"><HEAD SecCnt="1"><DOCSUMMARY><TITLE>운영 지침</TITLE></DOCSUMMARY></HEAD>`
      + `<BODY><SECTION><P><TEXT><CHAR>${text}</CHAR></TEXT></P></SECTION></BODY></HWPML>`,
  );
}

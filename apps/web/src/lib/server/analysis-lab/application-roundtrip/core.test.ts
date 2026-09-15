import assert from "node:assert/strict";
import { VERSION, type IRBlock, type IRCell } from "kordoc";
import type { RoundtripFieldCandidate } from "@/lib/server/analysis-lab/application-roundtrip/contract";
import {
  applicationDocumentRecommendationPriority,
  buildRoundtripFillValues,
  classifyRoundtripDocument,
  extractLocatedRoundtripFields,
  extractRhwpStructuralFields,
  generateRoundtripSampleValue,
  assessRoundtripInputField,
  inferRoundtripInputKind,
  hasNonOverridableStructuralRejection,
  isNarrativeInstructionPlaceholder,
  isUnsupportedNestedMediaTextTarget,
  suppressFixedTableRoleCandidates,
} from "./core";

assert.equal(VERSION, "4.2.3", "왕복 실험은 검증된 Kordoc 4.2.3을 사용해야 한다");

assert.ok(
  applicationDocumentRecommendationPriority("[서식1] 기술지원 신청서.hwp")
    > applicationDocumentRecommendationPriority("★(필독) 신청서류 작성 및 발급방법 안내.hwp"),
  "명시된 주 신청 양식은 빈 표가 많은 작성 안내보다 우선해야 한다",
);

const announcement = classifyRoundtripDocument({
  filename: "2026년 창업지원사업 모집공고문.hwp",
  markdown: "모집 공고\n신청기간: 2026. 7. 1. ~ 7. 31.\n지원대상과 선정절차 및 유의사항",
  fields: [],
  formConfidence: 0.1,
});
assert.equal(announcement.role, "announcement");

const announcementWithEmbeddedApplication = classifyRoundtripDocument({
  filename: "2026년 참가기업 모집 공고문.hwpx",
  markdown: [
    "모집 공고\n신청기간과 지원대상 및 선정절차",
    "【별지 제1호 서식】사업신청서",
    "신청기업 대표자 담당자 연락처 사업자등록번호",
  ].join("\n"),
  fields: Array.from({ length: 5 }, (_, index) =>
    field({ id: `embedded-application-${index}`, label: `신청 항목 ${index}`, occurrence: index })),
  formConfidence: 0.5,
});
assert.equal(
  announcementWithEmbeddedApplication.role,
  "application_form",
  "공고문 뒤에 명시된 별지 신청서와 빈 입력 구조가 함께 있으면 합본 양식으로 분류해야 한다",
);

const announcementWithSubmissionListOnly = classifyRoundtripDocument({
  filename: "2026년 참가기업 모집 공고문.hwpx",
  markdown: "모집 공고\n제출서류: 사업신청서(별지 제1호) 1부\n신청기간과 지원대상 및 선정절차",
  fields: Array.from({ length: 5 }, (_, index) =>
    field({ id: `submission-list-${index}`, label: `신청 항목 ${index}`, occurrence: index })),
  formConfidence: 0.5,
});
assert.equal(
  announcementWithSubmissionListOnly.role,
  "announcement",
  "제출서류 목록에서 신청서 이름만 언급한 공고를 합본 양식으로 오인하면 안 된다",
);

const guidance = classifyRoundtripDocument({
  filename: "2. (관리지침) 온실가스 국제감축사업 관리지침(2026.3.)_수정.hwpx",
  markdown: [
    "신청기업 대표자 담당자 연락처 사업자등록번호".repeat(40),
    "사업개요 추진계획 사업화 계획 시장현황".repeat(14),
    "모집 공고 신청기간 지원대상 선정절차 유의사항".repeat(5),
    "개인정보 수집 서약합니다 확약합니다 증빙서류".repeat(30),
  ].join("\n"),
  fields: Array.from({ length: 203 }, (_, index) =>
    field({ id: `guidance-${index}`, label: `지침 표 ${index}`, occurrence: index })),
  formConfidence: 0.49,
});
assert.equal(
  guidance.role,
  "announcement",
  "독립 관리지침의 빈 표와 신청 관련 서술을 빠른 작성 양식으로 오인하면 안 된다",
);

const policyDocument = classifyRoundtripDocument({
  filename: "붙임 3-1. 산업기술혁신사업 공통 운영요령(고시 제2024-218호).hwpx",
  markdown: "사업자 대표자 신청기업 사업개요 추진계획 개인정보 수집".repeat(80),
  fields: Array.from({ length: 905 }, (_, index) =>
    field({ id: `policy-${index}`, label: `정책 표 ${index}`, occurrence: index })),
  formConfidence: 0.64,
});
assert.equal(
  policyDocument.role,
  "announcement",
  "법령·규정·운영요령의 대량 빈 표를 신청서로 오인해 LLM 비용을 쓰면 안 된다",
);

const guidanceWithApplication = classifyRoundtripDocument({
  filename: "관리지침 및 신청서.hwpx",
  markdown: "신청기업 대표자 담당자 연락처 사업자등록번호",
  fields: Array.from({ length: 5 }, (_, index) =>
    field({ id: `combined-${index}`, label: `신청 항목 ${index}`, occurrence: index })),
  formConfidence: 0.5,
});
assert.equal(
  guidanceWithApplication.role,
  "application_form",
  "파일명이 신청서를 명시하면 관리지침 표현만으로 양식을 제외하면 안 된다",
);

for (const filename of ["연구개발비 사용 기준.hwp", "정보통신방송연구개발관리규정.hwp"]) {
  const input = { filename, markdown: "[시행 2026. 5. 6.]\n제1조(목적) 이 고시는 연구비 기준을 정한다.\n신청기업 대표자 연락처",
    fields: [], formConfidence: 0 };
  assert.equal(classifyRoundtripDocument(input).role, "announcement", "고시 본문과 파일명이 함께 입증하는 독립 참고자료");
  assert.notEqual(classifyRoundtripDocument({ ...input, markdown: "내용" }).role, "announcement", "사용 기준이라는 파일명만으로 미분류 원본을 면제하지 않는다");
  assert.equal(classifyRoundtripDocument({ ...input, filename: "연구개발비 사용 기준 및 신청서.hwp" }).role, "application_form", "실제 신청서 합본은 고시 신호만으로 제외하지 않는다");
}
assert.equal(classifyRoundtripDocument({filename:"신규과제 제안요청서.hwp",markdown:"관리번호 2026-005\n과제명: 수중 통신\n1. 개요\n연구내용",
  fields:Array.from({length:6},(_,i)=>field({id:`rfp-${i}`,label:`항목${i}`,occurrence:0})),formConfidence:1}).role,"announcement",
  "제안요청서의 지정 과제 내용과 빈 표를 신청 입력으로 오인하지 않는다");

const resultReport = classifyRoundtripDocument({
  filename: "(붙임 3) 결과보고서.hwp",
  markdown: "신청기업 대표자 담당자 연락처 사업자등록번호".repeat(20),
  fields: Array.from({ length: 53 }, (_, index) =>
    field({ id: `result-${index}`, label: `결과 항목 ${index}`, occurrence: index })),
  formConfidence: 0.7,
});
assert.equal(
  resultReport.role,
  "announcement",
  "선정 이후 결과보고서를 최초 신청 양식으로 오인하면 안 된다",
);

const consentOnly = classifyRoundtripDocument({
  filename: "⑥ 개인정보 동의서.hwp",
  markdown: "신청기업 대표자 담당자 연락처 개인정보 수집 동의".repeat(15),
  fields: Array.from({ length: 12 }, (_, index) =>
    field({ id: `consent-${index}`, label: `동의 항목 ${index}`, occurrence: index })),
  formConfidence: 0.6,
});
assert.equal(
  consentOnly.role,
  "evidence",
  "독립 개인정보 동의서를 신청서로 오인하면 안 된다",
);

const agreementOnly = classifyRoundtripDocument({
  filename: "붙임_2._제조데이터_AI_활용_컨설팅_협약서.hwpx",
  markdown: "신청기업 대표자 담당자 연락처 사업자등록번호".repeat(15),
  fields: Array.from({ length: 16 }, (_, index) =>
    field({ id: `agreement-${index}`, label: `협약 항목 ${index}`, occurrence: index })),
  formConfidence: 0.7,
});
assert.equal(
  agreementOnly.role,
  "evidence",
  "선정 이후 협약서를 최초 신청 양식으로 오인하면 안 된다",
);

const plan = classifyRoundtripDocument({
  filename: "붙임2 사업계획서 양식.hwpx",
  markdown: "사업개요\n문제인식\n실현가능성\n성장전략\n시장현황\n추진계획",
  fields: [field({ id: "plan-1", label: "과제명", occurrence: 0 })],
  formConfidence: 0.4,
});
assert.equal(plan.role, "business_plan");

assert.equal(assessRoundtripInputField({ label: "연번", type: "text", row: 0 }).recommended, false);
assert.equal(
  assessRoundtripInputField({ label: "[서식2] 기업소개 및 사업계획", type: "text", row: 2 }).recommended,
  false,
  "제출서류 목록의 서식명을 작성 필드로 오인하면 안 된다",
);
assert.equal(
  assessRoundtripInputField({ label: "경기도 양자-반도체 팹 융합활용 R&D 지원 사업", type: "text", row: 0 }).recommended,
  false,
);
assert.equal(assessRoundtripInputField({ label: "사업계획서 작성 목차", type: "text", row: 0 }).recommended, false);
assert.equal(assessRoundtripInputField({ label: "2026년    월     일", type: "date", row: 12 }).recommended, false);
assert.equal(assessRoundtripInputField({ label: "대표자명", type: "text", row: 2 }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "회사소개*", type: "text", row: 1, required: true }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "기업소개", type: "text", row: 3 }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "자기소개", type: "text", row: 3 }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "혁신성*", type: "text", row: 4, required: true }).recommended, true);
assert.equal(inferRoundtripInputKind("회사소개*", "text"), "textarea");
assert.equal(inferRoundtripInputKind("창업동기 및 신청사유(*)", "text"), "textarea");

const fixedPlaceholderFields = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 2,
    cols: 2,
    hasHeader: false,
    cells: [
      [
        { text: "신청금액", colSpan: 1, rowSpan: 1 },
        { text: "금: 백만원", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "사전상담", colSpan: 1, rowSpan: 1 },
        { text: "은행 지점\n( 담당자 ☎ )", colSpan: 1, rowSpan: 1 },
      ],
    ],
  },
}], "c".repeat(64)).fields;
for (const ownerLabel of ["신청금액", "사전상담"]) {
  const owner = fixedPlaceholderFields.find((candidate) => candidate.label === ownerLabel);
  assert.equal(owner?.empty, true, `${ownerLabel} 값 셀 안내문은 미작성 상태여야 한다`);
  assert.equal(owner?.recommendedInput, true, `${ownerLabel} 원문 라벨이 입력 후보여야 한다`);
  assert.match(owner?.inputSignals.join(" ") ?? "", /고정 양식 placeholder/);
}
for (const placeholderLabel of ["금: 백만원", "은행 지점\n( 담당자 ☎ )"]) {
  const placeholder = fixedPlaceholderFields.find((candidate) => candidate.label === placeholderLabel);
  if (!placeholder) continue;
  assert.equal(placeholder.recommendedInput, false, `${placeholderLabel} 안내문 자체를 앵커로 쓰면 안 된다`);
  assert.match(placeholder.inputSignals.join(" "), /앞 라벨/);
}

{
  const sourceSha256 = "5d9ad6200091e341c945f1c746b1512ded6f2d85f0aa21bd6f0eac5b566fe22c";
  const emptyCell = () => ({ text: "", colSpan: 1, rowSpan: 1 });
  const blocks: IRBlock[] = Array.from({ length: 109 }, () => ({ type: "paragraph", text: "" }));
  const companyRows = Array.from({ length: 6 }, () => Array.from({ length: 11 }, emptyCell));
  companyRows[5] = [
    { text: "법인등록번호", colSpan: 4, rowSpan: 1 },
    emptyCell(),
    emptyCell(),
    emptyCell(),
    { text: "해당 시", colSpan: 3, rowSpan: 1 },
    emptyCell(),
    emptyCell(),
    emptyCell(),
    { text: "부 □", colSpan: 3, rowSpan: 1 },
    emptyCell(),
    emptyCell(),
  ];
  blocks[106] = {
    type: "table",
    table: { rows: companyRows.length, cols: 11, hasHeader: false, cells: companyRows },
  };
  const mediaRows: IRCell[][] = Array.from(
    { length: 12 },
    () => Array.from({ length: 3 }, emptyCell),
  );
  mediaRows[11] = [
    { text: "이미지", colSpan: 2, rowSpan: 4 },
    emptyCell(),
    {
      text: "※ 아이템의 특징을 나타낼 수 있는 참고사진(이미지)·설계도 등 삽입(해당 시)",
      colSpan: 1,
      rowSpan: 1,
      blocks: [{
        type: "table",
        table: {
          rows: 1,
          cols: 1,
          hasHeader: false,
          cells: [[{
            text: "※ 아이템의 특징을 나타낼 수 있는 참고사진(이미지)·설계도 등 삽입(해당 시)",
            colSpan: 1,
            rowSpan: 1,
          }]],
        },
      }],
    },
  ];
  blocks[108] = {
    type: "table",
    table: { rows: mediaRows.length, cols: 3, hasHeader: false, cells: mediaRows },
  };

  const techFields = extractLocatedRoundtripFields(blocks, sourceSha256).fields;
  const corporateNumber = techFields.find((candidate) => candidate.fieldInstanceId === "851ed55f5c86157703600e13");
  assert.equal(corporateNumber?.label, "법인등록번호");
  assert.equal(corporateNumber?.originalValue, "해당 시", "label colSpan 뒤 실제 조건형 placeholder를 값으로 결속");
  assert.equal(corporateNumber?.empty, true);
  assert.equal(corporateNumber?.recommendedInput, true, "정상 법인등록번호 label→value 입력을 보존");
  assert.equal(hasNonOverridableStructuralRejection(corporateNumber!), false);

  const consumedPlaceholder = techFields.find((candidate) => candidate.fieldInstanceId === "cd3932af28c5d1a4d81b8f70");
  assert.equal(consumedPlaceholder?.label, "해당 시");
  assert.equal(consumedPlaceholder?.location.col, 4);
  assert.equal(consumedPlaceholder?.recommendedInput, false);
  assert.equal(
    hasNonOverridableStructuralRejection(consumedPlaceholder!),
    true,
    "앞 법인등록번호의 값으로 소비된 origin만 별도 라벨 후보에서 안전 제외",
  );

  const media = techFields.find((candidate) => candidate.fieldInstanceId === "6543ab5d9e851d91c7177ed8");
  assert.equal(media?.label, "이미지");
  assert.equal(media?.recommendedInput, false);
  assert.equal(hasNonOverridableStructuralRejection(media!), true);
  assert.equal(
    isUnsupportedNestedMediaTextTarget(mediaRows[11]!, 0, mediaRows[11]![0]!),
    true,
    "TECH 이미지 label의 오른쪽 nested 삽입 host는 일반 textarea 지원으로 가장하지 않음",
  );
}

{
  const emptyCell = () => ({ text: "", colSpan: 1, rowSpan: 1 });
  const preservedTemplate = extractLocatedRoundtripFields([{
    type: "table",
    table: {
      rows: 1,
      cols: 5,
      hasHeader: false,
      cells: [[
        { text: "창업아이템명", colSpan: 4, rowSpan: 1 },
        emptyCell(),
        emptyCell(),
        emptyCell(),
        { text: "OO기술이 적용된 OO제품·서비스", colSpan: 1, rowSpan: 1 },
      ]],
    },
  }], "9".repeat(64)).fields.find((candidate) => candidate.label === "창업아이템명");
  assert.equal(preservedTemplate?.originalValue, "", "일반 template 값을 새 역할 추론으로 덮지 않음");
  assert.equal(preservedTemplate?.empty, true);
  assert.equal(preservedTemplate?.recommendedInput, true);

  const nestedNarrativeRows = [[
    { text: "제품 소개", colSpan: 2, rowSpan: 1 },
    emptyCell(),
    {
      text: "※ 제품의 특징을 구체적으로 작성해주세요.",
      colSpan: 1,
      rowSpan: 1,
      blocks: [{ type: "paragraph" as const, text: "※ 제품의 특징을 구체적으로 작성해주세요." }],
    },
  ]];
  assert.equal(
    isUnsupportedNestedMediaTextTarget(nestedNarrativeRows[0]!, 0, nestedNarrativeRows[0]![0]!),
    false,
    "nested 서술 안내문을 media host와 함께 차단하지 않음",
  );
  const captionRows = [[
    { text: "사진 제목", colSpan: 1, rowSpan: 1 },
    emptyCell(),
  ]];
  assert.equal(
    isUnsupportedNestedMediaTextTarget(captionRows[0]!, 0, captionRows[0]![0]!),
    false,
    "일반 사진 caption 텍스트 칸은 유지",
  );

  const standaloneConditional = extractLocatedRoundtripFields([{
    type: "table",
    table: {
      rows: 1,
      cols: 2,
      hasHeader: false,
      cells: [[{ text: "해당 시", colSpan: 1, rowSpan: 1 }, emptyCell()]],
    },
  }], "8".repeat(64)).fields.find((candidate) => candidate.label === "해당 시");
  assert.equal(
    hasNonOverridableStructuralRejection(standaloneConditional!),
    false,
    "다른 위치의 독립 '해당 시' 후보를 문자열만으로 차단하지 않음",
  );
}

const rowSpanningContactFields = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 3,
    cols: 5,
    hasHeader: false,
    cells: [
      [
        { text: "연락처", colSpan: 1, rowSpan: 3 },
        { text: "담당자", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "직위/직급", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "전화", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "이메일", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
    ],
  },
}], "d".repeat(64)).fields;
const contactOwner = rowSpanningContactFields.find((candidate) => candidate.label === "연락처");
assert.equal(contactOwner?.originalValue, "담당자", "KorDoc의 병합 셀 값 오인 조건을 재현해야 한다");
const contactPerson = rowSpanningContactFields.find((candidate) => candidate.label === "담당자");
assert.equal(contactPerson?.empty, true, "rowSpan 그룹의 담당자 칸은 실제 빈 입력이어야 한다");
assert.equal(contactPerson?.recommendedInput, true, "rowSpan 그룹 제목 때문에 담당자 입력을 제외하면 안 된다");
assert.doesNotMatch(contactPerson?.inputSignals.join(" ") ?? "", /값 placeholder/);

const emptyTestCell = () => ({ text: "", colSpan: 1, rowSpan: 1 });
const rowSpanningLaborFields = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 2,
    cols: 9,
    hasHeader: false,
    cells: [
      [
        { text: "노동자 수", colSpan: 1, rowSpan: 2 },
        { text: "총 인원 :        명", colSpan: 8, rowSpan: 1 },
        ...Array.from({ length: 7 }, emptyTestCell),
      ],
      [
        emptyTestCell(),
        { text: "남성 :    명 / 여성 :     명", colSpan: 4, rowSpan: 1 },
        ...Array.from({ length: 3 }, emptyTestCell),
        { text: "정규직:    명 / 비정규직:   명", colSpan: 4, rowSpan: 1 },
        ...Array.from({ length: 3 }, emptyTestCell),
      ],
    ],
  },
}], "e".repeat(64)).fields;
const totalHeadcountPlaceholder = rowSpanningLaborFields.find((candidate) => candidate.label.includes("총 인원"));
assert.equal(totalHeadcountPlaceholder?.empty, true, "총 인원 안내문 오인 조건을 재현해야 한다");
assert.equal(
  totalHeadcountPlaceholder?.recommendedInput,
  false,
  "rowSpan 그룹의 행 끝 값 placeholder를 독립 입력 라벨로 되살리면 안 된다",
);
assert.match(totalHeadcountPlaceholder?.inputSignals.join(" ") ?? "", /값 placeholder/);

const matrixRow = (...texts: string[]): IRCell[] => texts.map((text) => ({
  text,
  colSpan: 1,
  rowSpan: 1,
}));
const fixedMatrixRoleBlocks: IRBlock[] = [
  {
    type: "table",
    table: {
      rows: 5,
      cols: 7,
      hasHeader: true,
      cells: [
        matrixRow("구 분", "", "품 명", "규 격", "단 가", "수량", "소 계"),
        [
          { text: "제어시스템", colSpan: 2, rowSpan: 2 },
          emptyTestCell(), emptyTestCell(), emptyTestCell(), emptyTestCell(),
          { text: "개", colSpan: 1, rowSpan: 1 }, emptyTestCell(),
        ],
        matrixRow("", "", "", "", "", "개", ""),
        [
          { text: "컨트롤러", colSpan: 2, rowSpan: 2 },
          emptyTestCell(), emptyTestCell(), emptyTestCell(), emptyTestCell(),
          { text: "개", colSpan: 1, rowSpan: 1 }, emptyTestCell(),
        ],
        matrixRow("", "", "", "", "", "개", ""),
      ],
    },
  },
  {
    type: "table",
    table: {
      rows: 3,
      cols: 5,
      hasHeader: true,
      cells: [
        matrixRow("구분", "단가", "수량", "금액", "비고"),
        matrixRow("장비", "10", "1", "10", ""),
        matrixRow("계", "", "", "", ""),
      ],
    },
  },
  {
    type: "table",
    table: {
      rows: 2,
      cols: 9,
      hasHeader: true,
      cells: [
        matrixRow("", "사업 위치", "", "", "사업내용", "물량", "금액", "융자금", "자부담"),
        matrixRow("", "착공예정일", "", "", "계", "", "", "", ""),
      ],
    },
  },
];
const historicalFixedFields = [
  { ...field({ id: "fixed-control", label: "제어시스템", occurrence: 0 }), location: { blockIndex: 0, row: 1, col: 0, occurrence: 0, pageNumber: null } },
  { ...field({ id: "fixed-controller", label: "컨트롤러", occurrence: 0 }), location: { blockIndex: 0, row: 3, col: 0, occurrence: 0, pageNumber: null } },
  { ...field({ id: "fixed-total-last", label: "계", occurrence: 0 }), location: { blockIndex: 1, row: 2, col: 0, occurrence: 0, pageNumber: null } },
  { ...field({ id: "fixed-total-side", label: "계", occurrence: 1 }), location: { blockIndex: 2, row: 1, col: 4, occurrence: 1, pageNumber: null } },
];
suppressFixedTableRoleCandidates(historicalFixedFields, fixedMatrixRoleBlocks);
for (const fixed of historicalFixedFields) {
  assert.equal(fixed.recommendedInput, false, `${fixed.fieldInstanceId} 고정 matrix 라벨 안전 제외`);
  assert.equal(hasNonOverridableStructuralRejection(fixed), true);
}
const extractedFixedFields = extractLocatedRoundtripFields(
  fixedMatrixRoleBlocks,
  "9".repeat(64),
).fields;
for (const expected of historicalFixedFields) {
  const extracted = extractedFixedFields.find((candidate) => (
    candidate.location.blockIndex === expected.location.blockIndex
    && candidate.location.row === expected.location.row
    && candidate.location.col === expected.location.col
  ));
  assert.ok(extracted, `${expected.label} 고정 matrix 후보를 구조 추출해야 한다`);
  assert.equal(hasNonOverridableStructuralRejection(extracted), true);
}

const ordinarySameLabelFields = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 3,
    cols: 2,
    hasHeader: false,
    cells: [matrixRow("계", ""), matrixRow("제어시스템", ""), matrixRow("사업명", "")],
  },
}], "a".repeat(64)).fields;
for (const label of ["계", "제어시스템"]) {
  const ordinary = ordinarySameLabelFields.find((candidate) => candidate.label === label);
  assert.ok(ordinary, `${label} 동명 일반 2열 후보를 보존해야 한다`);
  assert.equal(hasNonOverridableStructuralRejection(ordinary), false);
}
assert.equal(
  ordinarySameLabelFields.find((candidate) => candidate.label === "사업명")?.recommendedInput,
  true,
  "실제 빈 인접 입력은 계속 추천해야 한다",
);
const unheadedTotal = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 2,
    cols: 5,
    hasHeader: false,
    cells: [matrixRow("장비", "10", "1", "10", ""), matrixRow("계", "", "", "", "")],
  },
}], "b".repeat(64)).fields.find((candidate) => (
  candidate.location.row === 1 && candidate.location.col === 0
));
assert.ok(unheadedTotal);
assert.equal(
  hasNonOverridableStructuralRejection(unheadedTotal),
  false,
  "header 의미가 없는 일반 표의 동명 값 후보까지 고정 집계로 단정하지 않는다",
);
const newMatrixRow = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 3,
    cols: 5,
    hasHeader: true,
    cells: [
      matrixRow("품명", "단가", "수량", "금액", "비고"),
      matrixRow("기존 장비", "10", "1", "10", ""),
      matrixRow("신규 장비", "", "", "", ""),
    ],
  },
}], "c".repeat(64)).fields.find((candidate) => (
  candidate.location.row === 2 && candidate.location.col === 0
));
assert.ok(newMatrixRow);
assert.equal(
  hasNonOverridableStructuralRejection(newMatrixRow),
  false,
  "다열 표의 마지막 빈 신규 행을 집계 band라는 이유만으로 제외하지 않는다",
);

const sameCellNarrativeLabel = "※ 기타 현재 상황, 개선하고자 하는 점 등 자유롭게 기술해주세요.";
const sameCellNarrativeFields = extractRhwpStructuralFields([{
  type: "table",
  table: {
    rows: 4,
    cols: 9,
    hasHeader: false,
    cells: [
      [
        { text: "업체명", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 8, rowSpan: 1 },
      ],
      [
        { text: "대표자명", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 8, rowSpan: 1 },
      ],
      [
        { text: sameCellNarrativeLabel, colSpan: 9, rowSpan: 1 },
        ...Array.from({ length: 8 }, emptyTestCell),
      ],
      [
        { text: "위와 같이 상담 지원을 신청합니다.\n신청인 : 대표 (서명)", colSpan: 9, rowSpan: 1 },
        ...Array.from({ length: 8 }, emptyTestCell),
      ],
    ],
  },
}], "f".repeat(64));
const sameCellNarrative = sameCellNarrativeFields.find((candidate) => candidate.label === sameCellNarrativeLabel);
assert.equal(sameCellNarrative?.inputKind, "textarea");
assert.deepEqual(sameCellNarrative?.location.target, {
  kind: "table_cell",
  row: 2,
  col: 0,
  textStart: 0,
  textEnd: sameCellNarrativeLabel.length,
  expectedText: sameCellNarrativeLabel,
  expectedSha256: "777be966576cf55f80c8c19540569941dfba8d597e185a395a4bd2dc11be0064",
});
assert.notEqual(sameCellNarrative?.location.target?.row, 3, "아래 선언·서명 셀을 장문 입력 대상으로 고르면 안 된다");

const ordinaryLongTextFields = extractRhwpStructuralFields([{
  type: "table",
  table: {
    rows: 4,
    cols: 2,
    hasHeader: false,
    cells: [
      [{ text: "업체명", colSpan: 1, rowSpan: 1 }, emptyTestCell()],
      [{ text: "대표자명", colSpan: 1, rowSpan: 1 }, emptyTestCell()],
      [{ text: "기업 현황", colSpan: 1, rowSpan: 1 }, emptyTestCell()],
      [{ text: "※ 사업 계획을 자유롭게 작성해주세요.", colSpan: 2, rowSpan: 1 }, emptyTestCell()],
    ],
  },
}], "0".repeat(64));
assert.equal(
  ordinaryLongTextFields.find((candidate) => candidate.label === "기업 현황")?.location.target,
  undefined,
  "별도 오른쪽 값 셀이 있는 일반 장문 라벨을 same-cell region으로 바꾸면 안 된다",
);
assert.equal(
  ordinaryLongTextFields.find((candidate) => candidate.label.includes("사업 계획"))?.location.target,
  undefined,
  "아래 고정 선언·서명 근거가 없는 full-width 제목형 장문은 same-cell region으로 열면 안 된다",
);

const recoveredMergedFields = extractRhwpStructuralFields([{
  type: "table",
  table: {
    rows: 6,
    cols: 7,
    hasHeader: true,
    cells: [
      [
        { text: "신청인", colSpan: 1, rowSpan: 3 },
        { text: "업체명", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 3, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "대표자 성명", colSpan: 2, rowSpan: 1 },
      ],
      [
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "생년월일", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 3, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "전화번호(핸드폰)", colSpan: 2, rowSpan: 1 },
      ],
      [
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "업태 / 종목", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "/", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "종사자수", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "사업체 규모", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "자산총액", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "총 매출액(전년도)", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "□ 신용보증서\n□ 부동산\n(□ 본인 □ 타인)", colSpan: 2, rowSpan: 1 },
      ],
      [
        { text: "조례 시행규칙에 따라 일자리기금 융자를 신청합니다. 서울특별시 용산구청장 귀하", colSpan: 2, rowSpan: 1 },
      ],
    ],
  },
}], "b".repeat(64), [
  { ...field({ id: "company", label: "업체명", occurrence: 0 }), location: { blockIndex: 0, row: 0, col: 1, occurrence: 0, pageNumber: null } },
  { ...field({ id: "birth", label: "생년월일", occurrence: 0 }), location: { blockIndex: 0, row: 1, col: 1, occurrence: 0, pageNumber: null } },
  { ...field({ id: "employee", label: "종사자수", occurrence: 0 }), location: { blockIndex: 0, row: 2, col: 5, occurrence: 0, pageNumber: null } },
  { ...field({ id: "assets", label: "자산총액", occurrence: 0 }), location: { blockIndex: 0, row: 3, col: 3, occurrence: 0, pageNumber: null } },
]);
assert.deepEqual(
  recoveredMergedFields.map((candidate) => candidate.label),
  ["대표자 성명", "전화번호(핸드폰)", "업태 / 종목", "총 매출액(전년도)"],
  "KorDoc이 빠뜨린 병합 표 오른쪽·placeholder 입력 라벨을 RHWP 후보로 회수해야 한다",
);
assert.equal(recoveredMergedFields.every((candidate) => candidate.source === "rhwp-structural"), true);
assert.equal(recoveredMergedFields.every((candidate) => candidate.writeOperation === "rhwp_field"), true);
const announcementSectionFields = extractRhwpStructuralFields([{
  type: "table",
  table: {
    rows: 1,
    cols: 3,
    hasHeader: false,
    cells: [[
      { text: "1", colSpan: 1, rowSpan: 1 },
      { text: "", colSpan: 1, rowSpan: 1 },
      { text: "사업개요", colSpan: 1, rowSpan: 1 },
    ]],
  },
}], "d".repeat(64));
assert.deepEqual(
  announcementSectionFields,
  [],
  "명시적인 입력칸 근거가 없는 공고 절 제목을 병합 표의 숨은 값 셀로 추정하면 안 된다",
);
const fixedProcessFields = extractRhwpStructuralFields([{
  type: "table",
  table: {
    rows: 3,
    cols: 2,
    hasHeader: false,
    cells: [
      [
        { text: "사업장 → 진주시\n※사전기술지원결과서 첨부", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "사업비 지출,\n모니터링 2회\n(마케팅 현황 점검 등)", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "◦ 계획의 타당성\n- 목표시장 및 고객 분석(15)\n- 예산편성의 적정성(15)", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
    ],
  },
}], "e".repeat(64));
assert.deepEqual(
  fixedProcessFields,
  [],
  "진행 흐름·횟수가 적힌 일정·배점 심사 설명은 빈 이웃 셀이 있어도 입력 필드가 아니다",
);

const restoredPlaceholderFields = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 3,
    cols: 4,
    hasHeader: false,
    cells: [
      [
        { text: "담당자", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "핸드폰", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "희망 지원기간", colSpan: 1, rowSpan: 1 },
        { text: "00년 00월 00일\n∼ 00월 00일", colSpan: 3, rowSpan: 1 },
      ],
      [
        { text: "기술지원 요구내용", colSpan: 1, rowSpan: 1 },
        { text: "▪ (애로사항)\n-\n▪ (요구내용)\n-", colSpan: 3, rowSpan: 1 },
      ],
    ],
  },
}], "f".repeat(64)).fields;
for (const label of ["핸드폰", "희망 지원기간", "기술지원 요구내용"]) {
  const restored = restoredPlaceholderFields.find((candidate) => candidate.label === label);
  assert.equal(restored?.empty, true, `${label} 원문 placeholder는 미작성 상태여야 한다`);
  assert.equal(restored?.recommendedInput, true, `${label}은 실제 입력으로 복구해야 한다`);
}
assert.equal(
  isNarrativeInstructionPlaceholder(
    "자기소개",
    "※ 자유롭게 기술하되, 성장과정과 학교생활 및 전공분야가 나타나도록 작성",
  ),
  true,
);
assert.equal(
  isNarrativeInstructionPlaceholder("자기소개", "저는 데이터 분석 경험을 바탕으로 창업했습니다."),
  false,
  "사용자가 이미 작성한 자기소개를 안내문으로 오인하면 안 된다",
);
assert.equal(
  isNarrativeInstructionPlaceholder("개인정보 동의", "※ 내용을 확인한 뒤 동의 여부를 선택"),
  false,
  "서술형 라벨이 아닌 고정 안내문은 자동 입력 대상으로 승격하지 않는다",
);
assert.equal(
  isNarrativeInstructionPlaceholder("기술지원 요구내용", "▪ (애로사항)\n-\n▪ (요구내용)\n-"),
  true,
  "항목별 글머리표만 남은 서술형 입력 안내를 실제 작성 칸으로 복구해야 한다",
);

assert.deepEqual(
  generateRoundtripSampleValue({ label: "사업자등록번호", type: "idnum" }),
  { value: "123-45-67890", reason: "사업자등록번호 형식 샘플" },
);

const repeated = [
  field({ id: "name-0", label: "성명", occurrence: 0, originalValue: "기존대표" }),
  field({ id: "name-1", label: "성명", occurrence: 1 }),
];
const prepared = buildRoundtripFillValues(repeated, { "name-1": "김창업" });
assert.deepEqual(prepared.values, { "성명": ["기존대표", "김창업"] });
assert.deepEqual(prepared.requested.map((item) => item.field.fieldInstanceId), ["name-1"]);

console.log("application-roundtrip core tests: ok");

function field(input: {
  id: string;
  label: string;
  occurrence: number;
  originalValue?: string;
}): RoundtripFieldCandidate {
  return {
    fieldInstanceId: input.id,
    label: input.label,
    displayLabel: input.label,
    normalizedLabel: input.label,
    originalValue: input.originalValue ?? "",
    type: "text",
    required: false,
    empty: !input.originalValue,
    recommendedInput: true,
    inputLikelihood: 0.9,
    inputSignals: ["테스트"],
    sampleValue: "샘플",
    sampleReason: "테스트",
    source: "kordoc-form",
    inputKind: "text",
    writeOperation: "kordoc_field",
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "heuristic",
    llmConfidence: null,
    location: { blockIndex: 1, row: input.occurrence, col: 1, occurrence: input.occurrence, pageNumber: null },
  };
}

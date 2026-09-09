import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PremisesProfileValue } from "@cunote/contracts";
import {
  PremisesInputPanel,
  buildPremisesAnswer,
  premisesAnswerDraftFromValue,
  type PremisesAnswerDraft,
} from "./PremisesInputPanel";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const firstLocationId = "123e4567-e89b-42d3-a456-426614174000";
const secondLocationId = "223e4567-e89b-42d3-a456-426614174000";
const generatedLocationId = "323e4567-e89b-42d3-a456-426614174000";
const today = "2026-09-09";
const validDraft: PremisesAnswerDraft = {
  locations: [{
    locationId: firstLocationId,
    facilityType: "headquarters",
    sidoCode: "11",
    validFrom: "2024-01-01",
    validTo: null,
  }],
  coverageFacilityTypes: ["headquarters"],
  coverageValidFrom: "2025-01-01",
  coverageValidTo: today,
  completeness: "complete",
};

let generatedCount = 0;
const built = buildPremisesAnswer(validDraft, {
  createLocationId: () => {
    generatedCount += 1;
    return generatedLocationId;
  },
  today,
});
assert.equal(built.ok, true);
if (!built.ok) throw new Error("valid premises draft must build");
assert.equal(generatedCount, 0, "저장된 행의 locationId를 새로 만들면 안 됩니다.");
assert.deepEqual(built.locationIds, [firstLocationId]);
assert.deepEqual(built.answer, {
  field: "premises",
  mode: "replace",
  value: {
    schemaVersion: "premises-v1",
    locations: [{
      locationId: firstLocationId,
      facilityType: "headquarters",
      sidoCode: "11",
      validFrom: "2024-01-01",
      validTo: null,
    }],
    coverage: {
      facilityTypes: ["headquarters"],
      validFrom: "2025-01-01",
      validTo: today,
      completeness: "complete",
    },
  },
}, "UI payload는 서버가 stamp할 coverage.asOf를 보내지 않아야 합니다.");
assert.equal(JSON.stringify(built.answer).includes("asOf"), false);

const savedValue: PremisesProfileValue = {
  ...(built.answer.value as Omit<PremisesProfileValue, "coverage">),
  coverage: {
    ...(built.answer.value as { coverage: Omit<PremisesProfileValue["coverage"], "asOf"> }).coverage,
    asOf: "2026-09-09T01:23:45.000Z",
  },
};
const reopenedDraft = premisesAnswerDraftFromValue(savedValue);
assert.deepEqual(reopenedDraft, validDraft, "저장 후 재열기는 기존 행·ID·기간·coverage를 그대로 복원해야 합니다.");

const rebuilt = buildPremisesAnswer(reopenedDraft, {
  createLocationId: () => {
    generatedCount += 1;
    return generatedLocationId;
  },
  today,
});
assert.equal(rebuilt.ok, true);
assert.equal(generatedCount, 0, "재열기 후 제출에서도 기존 locationId를 교체하면 안 됩니다.");
if (!rebuilt.ok) throw new Error("reopened premises draft must build");
assert.deepEqual(rebuilt.answer, built.answer);
assert.equal(JSON.stringify(rebuilt.answer).includes(savedValue.coverage.asOf), false, "과거 asOf를 재전송하면 안 됩니다.");

generatedCount = 0;
const multiLocation = buildPremisesAnswer({
  ...validDraft,
  locations: [
    validDraft.locations[0]!,
    {
      locationId: null,
      facilityType: "factory",
      sidoCode: "41",
      validFrom: "2025-03-01",
      validTo: "2026-08-31",
    },
  ],
  coverageFacilityTypes: ["headquarters", "factory"],
}, {
  createLocationId: () => {
    generatedCount += 1;
    return generatedLocationId;
  },
  today,
});
assert.equal(multiLocation.ok, true);
if (!multiLocation.ok) throw new Error("multi-location draft must build");
assert.equal(generatedCount, 1, "새 행에 대해서만 locationId를 만들어야 합니다.");
assert.deepEqual(multiLocation.locationIds, [firstLocationId, generatedLocationId]);
assert.deepEqual(
  (multiLocation.answer.value as PremisesProfileValue).locations.map((location) => ({
    locationId: location.locationId,
    validTo: location.validTo,
  })),
  [
    { locationId: firstLocationId, validTo: null },
    { locationId: generatedLocationId, validTo: "2026-08-31" },
  ],
);

generatedCount = 0;
const emptyLocations = buildPremisesAnswer({
  ...validDraft,
  locations: [],
}, {
  createLocationId: () => {
    generatedCount += 1;
    return generatedLocationId;
  },
  today,
});
assert.equal(emptyLocations.ok, true, "사용자가 명시적으로 모든 행을 지운 답변은 저장할 수 있어야 합니다.");
assert.equal(generatedCount, 0);
if (!emptyLocations.ok) throw new Error("empty premises list must build");
assert.deepEqual((emptyLocations.answer.value as PremisesProfileValue).locations, []);

const invalidCases: Array<{
  name: string;
  draft: PremisesAnswerDraft;
  expectedField: string;
}> = [
  {
    name: "시설 유형 누락",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, facilityType: null }] },
    expectedField: "locations.0.facilityType",
  },
  {
    name: "자유문구 시설",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, facilityType: "지점" as never }] },
    expectedField: "locations.0.facilityType",
  },
  {
    name: "시도 누락",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, sidoCode: null }] },
    expectedField: "locations.0.sidoCode",
  },
  {
    name: "시군구 입력",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, sidoCode: "강남구" }] },
    expectedField: "locations.0.sidoCode",
  },
  {
    name: "등록일 누락",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, validFrom: "" }] },
    expectedField: "locations.0.validFrom",
  },
  {
    name: "상대 날짜",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, validFrom: "오늘" }] },
    expectedField: "locations.0.validFrom",
  },
  {
    name: "미래 등록 시작일",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, validFrom: "2026-09-10" }] },
    expectedField: "locations.0.validTo",
  },
  {
    name: "미래 이전 예정일",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, validTo: "2026-09-10" }] },
    expectedField: "locations.0.validTo",
  },
  {
    name: "사업장 기간 역전",
    draft: { ...validDraft, locations: [{ ...validDraft.locations[0]!, validTo: "2023-12-31" }] },
    expectedField: "locations.0.validTo",
  },
  {
    name: "coverage 시설 유형 누락",
    draft: { ...validDraft, coverageFacilityTypes: [] },
    expectedField: "coverageFacilityTypes",
  },
  {
    name: "존재하지 않는 날짜",
    draft: { ...validDraft, coverageValidFrom: "2026-02-30" },
    expectedField: "coverageValidFrom",
  },
  {
    name: "확인 종료일 누락",
    draft: { ...validDraft, coverageValidTo: "" },
    expectedField: "coverageValidTo",
  },
  {
    name: "미래 확인 시작일",
    draft: { ...validDraft, coverageValidFrom: "2026-09-10" },
    expectedField: "coverageValidTo",
  },
  {
    name: "미래 확인 종료일",
    draft: { ...validDraft, coverageValidTo: "2026-09-10" },
    expectedField: "coverageValidTo",
  },
  {
    name: "확인 기간 역전",
    draft: { ...validDraft, coverageValidFrom: "2026-09-09", coverageValidTo: "2026-09-08" },
    expectedField: "coverageValidTo",
  },
  {
    name: "등록 시작일이 확인 종료일보다 늦음",
    draft: {
      ...validDraft,
      locations: [{ ...validDraft.locations[0]!, validFrom: "2026-09-09" }],
      coverageValidTo: "2026-09-08",
    },
    expectedField: "locations.0.validFrom",
  },
  { name: "완전성 누락", draft: { ...validDraft, completeness: null }, expectedField: "completeness" },
  {
    name: "10개 초과",
    draft: { ...validDraft, locations: Array.from({ length: 11 }, () => ({ ...validDraft.locations[0]! })) },
    expectedField: "locations",
  },
];

for (const testCase of invalidCases) {
  const result = buildPremisesAnswer(testCase.draft, { createLocationId: () => generatedLocationId, today });
  assert.equal(result.ok, false, `${testCase.name} 입력은 거부해야 합니다.`);
  if (!result.ok) assert.equal(result.field, testCase.expectedField, testCase.name);
}

const invalidExistingId = buildPremisesAnswer({
  ...validDraft,
  locations: [{ ...validDraft.locations[0]!, locationId: "not-a-uuid" }],
}, { createLocationId: () => generatedLocationId, today });
assert.equal(invalidExistingId.ok, false);
if (!invalidExistingId.ok) assert.equal(invalidExistingId.field, "locations.0.locationId");

const duplicateIds = buildPremisesAnswer({
  ...validDraft,
  locations: [
    validDraft.locations[0]!,
    { ...validDraft.locations[0]!, locationId: firstLocationId.toUpperCase() },
  ],
}, { createLocationId: () => generatedLocationId, today });
assert.equal(duplicateIds.ok, false, "대소문자만 다른 동일 UUID도 중복으로 거부해야 합니다.");
if (!duplicateIds.ok) assert.equal(duplicateIds.field, "locations.1.locationId");

const elevenSavedRows = premisesAnswerDraftFromValue({
  ...savedValue,
  locations: Array.from({ length: 11 }, (_, index) => ({
    ...savedValue.locations[0]!,
    locationId: `${String(index + 1).padStart(8, "0")}-e89b-42d3-a456-426614174000`,
  })),
});
assert.equal(elevenSavedRows.locations.length, 11, "잘못된 초기값도 UI가 조용히 행을 삭제하면 안 됩니다.");
const oversizedReopen = buildPremisesAnswer(elevenSavedRows, {
  createLocationId: () => generatedLocationId,
  today,
});
assert.equal(oversizedReopen.ok, false);
if (!oversizedReopen.ok) assert.equal(oversizedReopen.field, "locations");

const multiValue: PremisesProfileValue = {
  schemaVersion: "premises-v1",
  locations: [
    savedValue.locations[0]!,
    {
      locationId: secondLocationId,
      facilityType: "factory",
      sidoCode: "41",
      validFrom: "2025-03-01",
      validTo: "2026-08-31",
    },
  ],
  coverage: {
    facilityTypes: ["headquarters", "factory"],
    validFrom: "2025-01-01",
    validTo: today,
    asOf: "2026-09-09T01:23:45.000Z",
    completeness: "partial",
  },
};
const html = renderToStaticMarkup(
  <PremisesInputPanel
    initialValue={multiValue}
    readOnly={false}
    submitting={false}
    onCancel={() => {}}
    onSubmit={async () => {}}
  />,
);
assert.ok(html.includes("내 개인 매칭 정보로 저장돼요"));
assert.ok(html.includes("같은 회사의 다른 구성원과 공유되지 않습니다"));
assert.ok(html.includes("선택한 시설 유형과 입력한 확인 기간에만 적용됩니다"));
assert.ok(html.includes("탈락을 자동 확정하지 않습니다"));
assert.ok(html.includes("시군구·상세 주소"));
assert.ok(html.includes("사업장 1"));
assert.ok(html.includes("사업장 2"));
assert.ok(html.includes("사업장 추가 (2/10)"));
assert.ok(html.includes("2026-08-31"), "저장된 validTo가 재열기 화면에 남아야 합니다.");
assert.ok(html.includes('type="date"'));
assert.equal(html.includes("textarea"), false, "시군구·이전 예정·자유문구 입력을 열지 않습니다.");

const emptyHtml = renderToStaticMarkup(
  <PremisesInputPanel
    initialValue={{ ...savedValue, locations: [] }}
    readOnly={false}
    submitting={false}
    onCancel={() => {}}
    onSubmit={async () => {}}
  />,
);
assert.ok(emptyHtml.includes("입력한 사업장이 없습니다"));
assert.ok(emptyHtml.includes("자동 탈락으로 확정되지 않으며"));
assert.ok(emptyHtml.includes("사업장 추가 (0/10)"));

const disabledHtml = renderToStaticMarkup(
  <PremisesInputPanel
    initialValue={savedValue}
    readOnly={false}
    submitting
    onCancel={() => {}}
    onSubmit={async () => {}}
  />,
);
assert.ok(disabledHtml.includes("반영 중"));
assert.match(disabledHtml, /<button[^>]*disabled[^>]*>취소<\/button>/);
assert.match(disabledHtml, /<button[^>]*disabled[^>]*>반영 중<\/button>/);

const readOnlyHtml = renderToStaticMarkup(
  <PremisesInputPanel
    initialValue={multiValue}
    readOnly
    submitting={false}
    onCancel={() => {}}
    onSubmit={async () => {
      throw new Error("read-only panel must not expose a submit action");
    }}
  />,
);
assert.ok(readOnlyHtml.includes("읽기 전용 정보예요"));
assert.ok(readOnlyHtml.includes("이 회사 정보를 수정할 권한이 없어"));
assert.ok(readOnlyHtml.includes("사업장 1"));
assert.ok(readOnlyHtml.includes("사업장 2"));
assert.ok(readOnlyHtml.includes("2026-08-31"), "읽기 전용이어도 현재 값은 보여야 합니다.");
assert.equal(readOnlyHtml.includes("사업장 답변 반영"), false, "읽기 전용에는 저장 버튼이 없어야 합니다.");
assert.equal(readOnlyHtml.includes("사업장 추가 ("), false, "읽기 전용에는 추가 버튼이 없어야 합니다.");
assert.equal(readOnlyHtml.includes("이 행 삭제"), false, "읽기 전용에는 삭제 버튼이 없어야 합니다.");
assert.match(readOnlyHtml, /<input[^>]*disabled/);
assert.ok(readOnlyHtml.includes(">닫기</button>"));

const anonymousReadOnlyHtml = renderToStaticMarkup(
  <PremisesInputPanel
    initialValue={null}
    readOnly
    readOnlyMessage="로그인해 회사를 저장하거나 선택한 뒤 등록 사업장 정보를 입력할 수 있습니다."
    submitting={false}
    onCancel={() => {}}
    onSubmit={async () => {}}
  />,
);
assert.ok(anonymousReadOnlyHtml.includes("로그인해 회사를 저장하거나 선택한 뒤"));
assert.ok(anonymousReadOnlyHtml.includes("현재 익명 결과에는 등록 사업장 답변을 임시로 반영하지 않습니다."));
assert.equal(anonymousReadOnlyHtml.includes("내 개인 매칭 정보로 저장돼요"), false);
assert.equal(anonymousReadOnlyHtml.includes("사업장 답변 반영"), false, "익명 티저는 premises 임시 입력을 열지 않습니다.");

console.log("premises input panel multi-row, reopen, immutable-id, validation and privacy tests passed");

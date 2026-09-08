import assert from "node:assert/strict";
import { sourceCorrectionSelectPresentation } from "./SourceCorrectionForm";

const official = [
  { dimension: "employees" as const },
  { dimension: "revenue" as const },
];

assert.deepEqual(sourceCorrectionSelectPresentation({
  official,
  dimension: "employees",
  canWrite: true,
  busy: false,
}), { label: "상시근로자", disabled: false });

assert.deepEqual(sourceCorrectionSelectPresentation({
  official,
  dimension: "revenue",
  canWrite: true,
  busy: false,
}), { label: "연 매출", disabled: false }, "다른 공식 항목을 고르면 해당 한국어 라벨을 표시합니다");

assert.deepEqual(sourceCorrectionSelectPresentation({
  official: [],
  dimension: "",
  canWrite: true,
  busy: false,
}), { label: "선택할 공식 정보가 없습니다", disabled: true });

assert.deepEqual(sourceCorrectionSelectPresentation({
  official,
  dimension: "employees",
  canWrite: false,
  busy: false,
}), { label: "상시근로자", disabled: true }, "조회 전용이어도 raw enum 대신 의미 있는 라벨을 유지합니다");

assert.equal(sourceCorrectionSelectPresentation({
  official,
  dimension: "employees",
  canWrite: true,
  busy: true,
}).disabled, true);

console.log("SourceCorrectionForm.test.ts: all assertions passed");

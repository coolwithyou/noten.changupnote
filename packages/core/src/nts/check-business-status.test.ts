/**
 * classifyNtsBusinessStatus 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/nts/check-business-status.test.ts
 *
 * 커버: 계속(01)→active / 휴업(02)→suspended / 폐업(03)→closed /
 *       미등록(빈 코드·"등록되지 않은" 문구)→not_registered / 판정 불가 코드→active.
 */
import assert from "node:assert/strict";
import { classifyNtsBusinessStatus, type NtsBusinessStatusData } from "./check-business-status.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function makeData(overrides: Partial<NtsBusinessStatusData>): NtsBusinessStatusData {
  return {
    b_no: "1234567891",
    b_stt: "",
    b_stt_cd: "",
    tax_type: "",
    tax_type_cd: "",
    ...overrides,
  };
}

check("계속사업자(01) → active", () => {
  assert.equal(
    classifyNtsBusinessStatus(makeData({ b_stt: "계속사업자", b_stt_cd: "01" })),
    "active",
  );
});

check("휴업자(02) → suspended", () => {
  assert.equal(
    classifyNtsBusinessStatus(makeData({ b_stt: "휴업자", b_stt_cd: "02" })),
    "suspended",
  );
});

check("폐업자(03) → closed", () => {
  assert.equal(
    classifyNtsBusinessStatus(makeData({ b_stt: "폐업자", b_stt_cd: "03", end_dt: "20240115" })),
    "closed",
  );
});

check("빈 상태코드 → not_registered", () => {
  assert.equal(
    classifyNtsBusinessStatus(makeData({ b_stt_cd: "" })),
    "not_registered",
  );
});

check("tax_type '등록되지 않은' 문구 → not_registered", () => {
  assert.equal(
    classifyNtsBusinessStatus(
      makeData({ b_stt_cd: "", tax_type: "국세청에 등록되지 않은 사업자등록번호입니다." }),
    ),
    "not_registered",
  );
});

check("b_stt '등록되지 않은' 문구 → not_registered", () => {
  assert.equal(
    classifyNtsBusinessStatus(
      makeData({ b_stt_cd: "", b_stt: "국세청에 등록되지 않은 사업자입니다." }),
    ),
    "not_registered",
  );
});

check("판정 불가 상태코드는 보수적으로 active", () => {
  assert.equal(
    classifyNtsBusinessStatus(makeData({ b_stt_cd: "99", b_stt: "알 수 없음" })),
    "active",
  );
});

console.log(`\nclassifyNtsBusinessStatus: ${passed} cases passed.`);

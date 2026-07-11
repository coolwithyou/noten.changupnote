/**
 * NICE 신용 오퍼레이션(OCCD03/06/01) 파서 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/nicebiz/check-corp-credit.test.ts
 *
 * fixture = 2026-07-11 실측 형태 발췌. OCCD03 listCount 0 = clean, OCCD06 빈 리스트 = 없음.
 */
import assert from "node:assert/strict";
import {
  parseNiceCreditSummary,
  parseNiceNegativeInfo,
  parseNiceWorkout,
} from "./check-corp-credit.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── OCCD03 신용도판단정보 ──
check("OCCD03 clean(listCount 0) → 카운트 전부 0", () => {
  const info = parseNiceNegativeInfo({
    request: { requestedKey: "1248100998", requestedKeyType: "bizno" },
    data: { message: "데이터가 존재하지 않습니다.", listCount: 0, creditNegativeInfoList: [] },
  });
  assert.equal(info.counts.bb, 0);
  assert.equal(info.counts.fd, 0);
  assert.equal(info.counts.pb, 0);
  assert.equal(info.counts.sb, 0);
  assert.equal(info.counts.totalOcc, 0);
  assert.equal(info.listCount, 0);
  assert.equal(info.details.length, 0);
});

check("OCCD03 결격 있음(bbCnt/pbCnt>0) → 카운트·상세 파싱", () => {
  const info = parseNiceNegativeInfo({
    data: {
      listCount: 1,
      creditNegativeInfoList: [
        {
          totaloccCnt: 5,
          bbCnt: 2,
          fdCnt: 0,
          pbCnt: 3,
          sbCnt: 0,
          negativeInfoDetailList: [
            { typecode: "PB", causename: "국세체납" },
            { typecode: "BB", causename: "대위변제/대지급" },
          ],
        },
      ],
    },
  });
  assert.equal(info.counts.bb, 2);
  assert.equal(info.counts.pb, 3);
  assert.equal(info.counts.fd, 0);
  assert.equal(info.counts.totalOcc, 5);
  assert.equal(info.details.length, 2);
  assert.equal(info.details[0]!.typecode, "PB");
  assert.equal(info.details[0]!.causename, "국세체납");
});

// ── OCCD06 법정관리/워크아웃 ──
check("OCCD06 clean(빈 creditWorkoutList) → count 0", () => {
  const info = parseNiceWorkout({
    data: { message: "데이터가 존재하지 않습니다.", totalCount: 0, listCount: 0, creditWorkoutList: [] },
  });
  assert.equal(info.count, 0);
  assert.equal(info.items.length, 0);
});

check("OCCD06 있음 → count·항목(구분명/법원명/일자) 파싱", () => {
  const info = parseNiceWorkout({
    data: {
      totalCount: 1,
      listCount: 1,
      creditWorkoutList: [
        {
          lglmgmtRldDate: "20230206",
          lglmgmtdivcd: "70",
          lglmgmtdivnm: "파산선고결정공고",
          lwcnm: "서울회생법원",
          hngno: "2022하합111",
        },
      ],
    },
  });
  assert.equal(info.count, 1);
  assert.equal(info.items.length, 1);
  assert.equal(info.items[0]!.divName, "파산선고결정공고");
  assert.equal(info.items[0]!.courtName, "서울회생법원");
  assert.equal(info.items[0]!.date, "20230206");
  assert.equal(info.items[0]!.caseNo, "2022하합111");
});

check("OCCD06 totalCount 없으면 리스트 길이로 count", () => {
  const info = parseNiceWorkout({
    data: { creditWorkoutList: [{ lglmgmtdivnm: "회생절차개시" }, { lglmgmtdivnm: "회생계획인가" }] },
  });
  assert.equal(info.count, 2);
});

// ── OCCD01 신용요약(프로비저닝 시 파서만 검증 — 라이브는 403) ──
check("OCCD01 요약 파싱(suspensionInfoCnt/workoutCnt)", () => {
  const info = parseNiceCreditSummary({
    data: { listCount: 1, creditSummaryList: [{ suspensionInfoCnt: 0, workoutCnt: 1 }] },
  });
  assert.equal(info.suspensionInfoCnt, 0);
  assert.equal(info.workoutCnt, 1);
});

check("OCCD01 빈 리스트 → 카운트 null", () => {
  const info = parseNiceCreditSummary({ data: { listCount: 0, creditSummaryList: [] } });
  assert.equal(info.suspensionInfoCnt, null);
  assert.equal(info.workoutCnt, null);
});

console.log(`\nNICE check-corp-credit: ${passed} cases passed.`);

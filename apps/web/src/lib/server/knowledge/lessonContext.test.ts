/**
 * lessonContext 필드 팁 매칭 판정 단위 테스트 (node:assert, tsx 실행, DB 불필요).
 *
 * 사용: pnpm test:lesson-context
 *
 * K2(scope 어휘 정규화 — fieldKey 축) 매칭 규칙을 순수 함수(fieldLessonMatches)로 검증한다.
 *   ① fieldKey 동등성으로 문자열 미탐("직원 수"↔"상시근로자 수")을 잡는다.
 *   ② 양쪽 fieldKey 불일치 시 fieldPattern 이 문자열로 걸려도 매칭 안 함(오탐 재유입 금지).
 *   ③ fieldKey 없는 기존 케이스는 fieldPattern 문자열 폴백 그대로(회귀 없음).
 */
import assert from "node:assert/strict";
import {
  fieldLessonMatches,
  fieldPatternMatchesLabel,
  isProgramCoveredByAliases,
  listUncoveredPrograms,
  norm,
} from "./lessonContext";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("lessonContext 필드 팁 매칭 단위 테스트\n");

// ── ① fieldKey 동등성: 문자열로는 미탐이던 케이스를 잡는다 ──────────────
check("① 양쪽 fieldKey=employee_count 동등 → 매칭 (문자열 '직원 수' 로는 미탐이었을 케이스)", () => {
  const labelNorm = norm("상시근로자 수(명)");

  // 전제: 문자열 폴백만으로는 미탐이다("직원 수" 패턴은 "상시근로자 수" 라벨에 안 걸린다).
  assert.equal(
    fieldPatternMatchesLabel("직원 수", labelNorm),
    false,
    "문자열 폴백은 '직원 수' 패턴을 '상시근로자 수' 라벨에서 미탐해야 한다(격상의 전제)",
  );

  // K2: lesson·field 양쪽에 fieldKey=employee_count 가 있으면 동등성으로 매칭된다.
  assert.equal(
    fieldLessonMatches(
      { fieldKey: "employee_count", fieldPattern: "직원 수" },
      { fieldKey: "employee_count", labelNorm },
    ),
    true,
    "양쪽 fieldKey=employee_count 이면 라벨 문자열이 달라도 매칭되어야 한다",
  );
});

// ── ② fieldKey 불일치 → fieldPattern 이 문자열로 걸려도 매칭 안 함 ─────────
check("② 양쪽 fieldKey 불일치 → fieldPattern 문자열이 걸려도 매칭 안 함(폴백 미하강)", () => {
  const labelNorm = norm("매출액(최근)");

  // 문자열 폴백만 보면 lesson 의 fieldPattern '매출' 이 라벨 '매출액' 에 걸린다.
  assert.equal(
    fieldPatternMatchesLabel("매출", labelNorm),
    true,
    "폴백 관점에서는 '매출' 패턴이 '매출액' 라벨에 걸려야 한다(대조군)",
  );

  // 그러나 양쪽 다 fieldKey 보유 & 불일치이므로 동등성 단독 판정 → 매칭 안 함.
  assert.equal(
    fieldLessonMatches(
      { fieldKey: "employee_count", fieldPattern: "매출" },
      { fieldKey: "revenue", labelNorm },
    ),
    false,
    "양쪽 fieldKey 가 다르면(employee_count≠revenue) fieldPattern 폴백으로 내려가지 않아야 한다",
  );
});

// ── ③ fieldKey 없는 기존 케이스 → fieldPattern 문자열 폴백 회귀 없음 ───────
check("③ 한쪽이라도 fieldKey 없음 → fieldPattern 문자열 폴백(기존 동작 유지)", () => {
  const labelNorm = norm("사업 아이템 개요");

  // field 에 fieldKey 없음(프로필 질문 등) + lesson fieldPattern 보유 → 폴백 매칭.
  assert.equal(
    fieldLessonMatches(
      { fieldKey: null, fieldPattern: "아이템 개요" },
      { fieldKey: null, labelNorm },
    ),
    true,
    "fieldKey 없는 필드는 fieldPattern 문자열 포함으로 매칭되어야 한다(회귀 없음)",
  );

  // lesson 에 fieldKey 만 있고 field 에 fieldKey 없음 + lesson fieldPattern 없음 → 매칭 안 함.
  assert.equal(
    fieldLessonMatches(
      { fieldKey: "item_summary", fieldPattern: null },
      { fieldKey: null, labelNorm },
    ),
    false,
    "한쪽만 fieldKey 이고 fieldPattern 이 없으면 매칭 근거가 없어 매칭 안 함",
  );

  // lesson fieldPattern 이 라벨과 무관 → 매칭 안 함.
  assert.equal(
    fieldLessonMatches(
      { fieldKey: null, fieldPattern: "대표자 서명" },
      { fieldKey: null, labelNorm },
    ),
    false,
    "관련 없는 fieldPattern 은 매칭되지 않아야 한다",
  );
});

// ── ④ K3: 프로그램 별칭 사전 커버리지 판정 ──────────────────────────
check("④ isProgramCoveredByAliases — 등록 프로그램은 covered, 미등록은 uncovered", () => {
  // 별칭 그룹 등록: LIPS/립스, TIPS/팁스, PRE-TIPS 계열.
  assert.equal(isProgramCoveredByAliases("LIPS"), true, "LIPS 는 별칭 그룹에 있어 covered");
  assert.equal(isProgramCoveredByAliases("립스"), true, "립스(한글 표기)도 covered");
  assert.equal(
    isProgramCoveredByAliases("수출바우처"),
    false,
    "수출바우처는 별칭 사전 미등록 → uncovered",
  );
  // 복합: 토큰 1개라도 등록돼 있으면 covered(리터럴/변형 매칭 경로가 하나는 열림).
  assert.equal(
    isProgramCoveredByAliases("LIPS/수출바우처"),
    true,
    "LIPS 토큰이 등록돼 있으므로 복합 program 도 covered",
  );
});

check("⑤ listUncoveredPrograms — 미커버만 추림(중복 제거·null 무시·정렬)", () => {
  const out = listUncoveredPrograms([
    "LIPS",
    "수출바우처",
    " 수출바우처 ", // trim 후 중복
    null,
    undefined,
    "",
    "청년창업사관학교",
    "LIPS/수출바우처", // LIPS 토큰이 있어 covered → 제외
  ]);
  assert.deepEqual(
    out,
    ["수출바우처", "청년창업사관학교"],
    "미커버 값만 중복 없이 정렬되어야 한다(LIPS·복합·빈값은 제외)",
  );
});

console.log(`\n총 ${passed}개 통과`);

/**
 * 결격 canonical 사전 무결성 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/disqualification/canonical.test.ts
 *
 * 커버(계약):
 *  - 문항→플래그 커버 완전성: 사전의 모든 flag가 1개 이상 문항에 커버된다(C1).
 *  - 문항 covers는 실재 canonical 플래그만 참조(오탈자 방지).
 *  - 예외→플래그 커버 매핑이 실재 플래그만 참조.
 *  - 플래그↔축 역참조 무결성(FLAG_AXIS·DISQUALIFICATION_FLAGS 상호 일치).
 *  - 라벨 전수 존재, 중복 없음.
 *  - 배제업종 KSIC 코드 형식.
 */
import assert from "node:assert/strict";
import {
  ALL_DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_EXCEPTIONS,
  DISQUALIFICATION_EXCEPTION_LABELS,
  DISQUALIFICATION_FLAG_LABELS,
  DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_QUESTIONS,
  EXCEPTION_FLAG_COVERAGE,
  EXCLUDED_INDUSTRIES,
  EXCLUDED_INDUSTRY_KSIC_CODES,
  FLAG_AXIS,
  QUESTION_FLAG_COVERAGE,
  type DisqualificationFlag,
} from "./canonical.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const flagSet = new Set<DisqualificationFlag>(ALL_DISQUALIFICATION_FLAGS);

check("모든 canonical 플래그는 1개 이상 문항에 커버된다(C1 완전성)", () => {
  const covered = new Set<DisqualificationFlag>();
  for (const question of DISQUALIFICATION_QUESTIONS) {
    for (const flag of question.covers) covered.add(flag);
  }
  const uncovered = ALL_DISQUALIFICATION_FLAGS.filter((flag) => !covered.has(flag));
  assert.deepEqual(uncovered, [], `커버되지 않은 플래그: ${uncovered.join(", ")}`);
});

check("문항 covers는 실재 canonical 플래그만 참조한다", () => {
  for (const question of DISQUALIFICATION_QUESTIONS) {
    for (const flag of question.covers) {
      assert.ok(flagSet.has(flag), `문항 ${question.id}가 미지의 플래그 ${flag}를 참조`);
    }
  }
});

check("문항 covers 플래그의 축은 문항 축과 일치한다", () => {
  for (const question of DISQUALIFICATION_QUESTIONS) {
    for (const flag of question.covers) {
      assert.equal(
        FLAG_AXIS[flag],
        question.axis,
        `문항 ${question.id}(축 ${question.axis})가 다른 축 플래그 ${flag}(${FLAG_AXIS[flag]})를 커버`,
      );
    }
  }
});

check("QUESTION_FLAG_COVERAGE는 DISQUALIFICATION_QUESTIONS와 동기화된다", () => {
  assert.equal(Object.keys(QUESTION_FLAG_COVERAGE).length, DISQUALIFICATION_QUESTIONS.length);
  for (const question of DISQUALIFICATION_QUESTIONS) {
    assert.deepEqual(QUESTION_FLAG_COVERAGE[question.id], question.covers);
  }
});

check("문항 간 플래그 중복 없음(각 플래그는 정확히 1개 문항에 귀속)", () => {
  const seen = new Map<DisqualificationFlag, string>();
  for (const question of DISQUALIFICATION_QUESTIONS) {
    for (const flag of question.covers) {
      const prior = seen.get(flag);
      assert.equal(prior, undefined, `플래그 ${flag}가 ${prior}와 ${question.id}에 중복 귀속`);
      seen.set(flag, question.id);
    }
  }
});

check("FLAG_AXIS와 DISQUALIFICATION_FLAGS가 상호 일치한다", () => {
  // FLAG_AXIS 키 == 전체 플래그
  assert.deepEqual(new Set(Object.keys(FLAG_AXIS)), flagSet);
  // 축별 목록과 역참조 일치
  for (const [axis, flags] of Object.entries(DISQUALIFICATION_FLAGS)) {
    for (const flag of flags) {
      assert.equal(FLAG_AXIS[flag], axis, `${flag}의 축이 ${axis}와 불일치`);
    }
  }
});

check("모든 플래그에 한국어 라벨이 있고 라벨 키가 정확히 플래그 집합과 일치한다", () => {
  assert.deepEqual(new Set(Object.keys(DISQUALIFICATION_FLAG_LABELS)), flagSet);
  for (const flag of ALL_DISQUALIFICATION_FLAGS) {
    assert.ok(DISQUALIFICATION_FLAG_LABELS[flag]?.trim().length ?? 0 > 0, `${flag} 라벨 누락`);
  }
});

check("canonical 플래그 전체에 중복 값이 없다", () => {
  assert.equal(new Set(ALL_DISQUALIFICATION_FLAGS).size, ALL_DISQUALIFICATION_FLAGS.length);
});

check("예외→플래그 커버는 실재 플래그만 참조하고 모든 예외에 라벨이 있다", () => {
  assert.deepEqual(
    new Set(Object.keys(EXCEPTION_FLAG_COVERAGE)),
    new Set(DISQUALIFICATION_EXCEPTIONS),
  );
  for (const exception of DISQUALIFICATION_EXCEPTIONS) {
    assert.ok(DISQUALIFICATION_EXCEPTION_LABELS[exception]?.trim(), `${exception} 라벨 누락`);
    for (const flag of EXCEPTION_FLAG_COVERAGE[exception]) {
      assert.ok(flagSet.has(flag), `예외 ${exception}가 미지의 플래그 ${flag}를 참조`);
    }
  }
});

check("배제업종 KSIC 코드는 KSIC 형식(대분류 문자 또는 숫자)이며 파생 목록이 중복 없이 일치한다", () => {
  const ksicPattern = /^[A-U]?\d{0,5}$/;
  const collected = new Set<string>();
  for (const industry of EXCLUDED_INDUSTRIES) {
    assert.ok(industry.key.trim(), "배제업종 key 누락");
    assert.ok(industry.label.trim(), "배제업종 label 누락");
    assert.ok(industry.ksic.length > 0, `배제업종 ${industry.key} KSIC 코드 누락`);
    for (const code of industry.ksic) {
      assert.ok(ksicPattern.test(code), `배제업종 ${industry.key}의 KSIC 코드 형식 오류: ${code}`);
      collected.add(code);
    }
  }
  assert.deepEqual(new Set(EXCLUDED_INDUSTRY_KSIC_CODES), collected);
  assert.equal(new Set(EXCLUDED_INDUSTRY_KSIC_CODES).size, EXCLUDED_INDUSTRY_KSIC_CODES.length);
});

console.log(`\n결격 canonical 사전 검증 통과: ${passed}건`);

/**
 * fieldAnswers 도메인 단위 테스트 (Apply Experience v2 · P2-2, node:assert, tsx 실행).
 *
 * 사용: pnpm test:field-answers
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md ADR-5, §8 Phase 2 P2-2.
 * 커버(설계 명시 4종):
 *   ① suggested 가 filledFields 에 절대 미포함
 *   ② 재생성(upsert) 후에도 accepted/edited 보존 · suggested 미유출
 *   ③ 미백필 행 부분 PATCH 시 기존 값 무유실
 *   ④ 정규화 label 중복 감지
 * 추가(메인 검수 기준 D2):
 *   ⑤ 미확정 suggested 는 HWPX 미채움(X-Cunote-Hwpx-Unfilled) 보고에 포함, dismissed 는 미포함
 */
import assert from "node:assert/strict";
import {
  applyFieldAnswerPatch,
  type DraftFieldAnswers,
  deriveFilledFields,
  detectDuplicateNormalizedLabels,
  mergeTemplateSuggestions,
  resolveFieldAnswers,
} from "./fieldAnswers";
import { listSuggestedUnfilled } from "./draftHwpxExport";

const ISO = "2026-07-10T00:00:00.000Z";
let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("fieldAnswers 도메인 단위 테스트\n");

// ① suggested(및 dismissed)는 파생 filledFields 에 절대 포함되지 않는다.
check("① deriveFilledFields: suggested/dismissed 는 미포함, accepted/edited 만 포함", () => {
  const answers: DraftFieldAnswers = {
    상호명: { value: "가나상사", status: "accepted", source: "profile", updatedAt: ISO },
    사업개요: { value: "LLM 제안값", status: "suggested", source: "llm", updatedAt: ISO },
    매출액: { value: "5억원", status: "edited", source: "user", updatedAt: ISO },
    폐업여부: { value: "기각된값", status: "dismissed", source: "template", updatedAt: ISO },
  };
  const filled = deriveFilledFields(answers);
  assert.deepEqual(filled, { 상호명: "가나상사", 매출액: "5억원" });
  assert.ok(!("사업개요" in filled), "suggested 유출");
  assert.ok(!("폐업여부" in filled), "dismissed 유출");
});

// ② 재생성(mergeTemplateSuggestions) 후에도 accepted/edited/dismissed 보존, 새 템플릿값은 suggested 로만.
check("② mergeTemplateSuggestions: 확정/기각 보존 · 새 생성값 suggested · export 미유출", () => {
  const current: DraftFieldAnswers = {
    상호명: { value: "확정상호", status: "accepted", source: "profile", updatedAt: ISO },
    매출액: { value: "5억원", status: "edited", source: "user", suggestedValue: "3억원", updatedAt: ISO },
    폐업여부: { value: "기각값", status: "dismissed", source: "template", updatedAt: ISO },
  };
  const templateFilled = {
    상호명: "템플릿상호(덮어쓰기 시도)",
    매출액: "템플릿매출(덮어쓰기 시도)",
    폐업여부: "템플릿폐업(덮어쓰기 시도)",
    사업개요: "새 템플릿 제안",
  };
  const merged = mergeTemplateSuggestions(current, templateFilled, { source: "template", at: ISO });

  // 이미 확정/기각인 label 은 재생성이 건드리지 않는다(멱등).
  assert.equal(merged.상호명?.value, "확정상호");
  assert.equal(merged.상호명?.status, "accepted");
  assert.equal(merged.매출액?.value, "5억원");
  assert.equal(merged.매출액?.status, "edited");
  assert.equal(merged.폐업여부?.status, "dismissed");
  // 새 템플릿값은 suggested 로만.
  assert.equal(merged.사업개요?.status, "suggested");
  assert.equal(merged.사업개요?.source, "template");
  // export 파생에는 suggested 미유출 — 확정값만.
  const filled = deriveFilledFields(merged);
  assert.deepEqual(filled, { 상호명: "확정상호", 매출액: "5억원" });
  assert.ok(!("사업개요" in filled), "재생성 suggested 가 export 로 유출");
});

// ③ 미백필 행(field_answers=NULL) 부분 PATCH 시 다른 label 값 무유실.
check("③ 미백필 행 구체화 + 부분 PATCH: 기존 값 무유실", () => {
  const row = {
    fieldAnswers: null,
    filledFields: { 상호명: "기존상호", 대표자: "기존대표", 소재지: "기존소재" },
  };
  // filledFields → fieldAnswers 선구체화(accepted/template).
  const current = resolveFieldAnswers(row);
  assert.equal(current.상호명?.status, "accepted");
  assert.equal(current.상호명?.source, "template");
  assert.equal(current.대표자?.value, "기존대표");

  // 상호명만 수정하는 부분 PATCH.
  const patched = applyFieldAnswerPatch(current, {
    상호명: { value: "새상호", status: "edited" },
  }, { at: ISO });

  // 나머지 label 은 그대로.
  assert.equal(patched.대표자?.value, "기존대표");
  assert.equal(patched.대표자?.status, "accepted");
  assert.equal(patched.소재지?.value, "기존소재");
  // 상호명은 갱신.
  assert.equal(patched.상호명?.value, "새상호");
  assert.equal(patched.상호명?.status, "edited");
  // 파생 filledFields 에 세 값 모두 유지.
  assert.deepEqual(deriveFilledFields(patched), {
    상호명: "새상호",
    대표자: "기존대표",
    소재지: "기존소재",
  });
});

// ④ 정규화 label 중복 감지: 서로 다른 원문 label 이 같은 정규화 키로 붕괴.
check("④ detectDuplicateNormalizedLabels: 괄호 붕괴 충돌 감지, 동일 원문은 비충돌", () => {
  const { duplicateLabels, collisions } = detectDuplicateNormalizedLabels([
    "기업명(국문)",
    "기업명(영문)",
    "매출액",
    "대표자 성명",
  ]);
  assert.ok(duplicateLabels.has("기업명(국문)"));
  assert.ok(duplicateLabels.has("기업명(영문)"));
  assert.ok(!duplicateLabels.has("매출액"));
  assert.ok(!duplicateLabels.has("대표자 성명"));
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]?.normalized, "기업명");
  assert.deepEqual(collisions[0]?.labels.sort(), ["기업명(국문)", "기업명(영문)"]);

  // 동일 원문 label 반복은 충돌이 아니다.
  const identical = detectDuplicateNormalizedLabels(["상호", "상호"]);
  assert.equal(identical.duplicateLabels.size, 0);
  assert.equal(identical.collisions.length, 0);
});

// ⑤ (검수 D2) 미확정 suggested 는 채움 제외 + 미채움 보고 포함. dismissed·확정·빈값은 미보고.
check("⑤ listSuggestedUnfilled: suggested 는 Unfilled 정직 보고, dismissed/확정/빈값 미포함", () => {
  const fieldAnswers: DraftFieldAnswers = {
    기업명: { value: "가나상사", status: "suggested", source: "profile", updatedAt: ISO }, // 실측 결함 케이스
    사업개요: { value: "LLM 제안값", status: "suggested", source: "llm", updatedAt: ISO },
    매출액: { value: "5억원", status: "accepted", source: "user", updatedAt: ISO },
    폐업여부: { value: "기각값", status: "dismissed", source: "template", updatedAt: ISO }, // 의도적 제외 → 미보고
    빈제안: { value: "   ", status: "suggested", source: "template", updatedAt: ISO }, // 값 없음 → 미보고
  };
  const filledFields = deriveFilledFields(fieldAnswers); // { 매출액 } 만
  const unfilled = listSuggestedUnfilled({ fieldAnswers, filledFields });
  const labels = unfilled.map((entry) => entry.label).sort();

  // accepted→suggested 로 되돌린 "기업명" 이 조용히 사라지지 않고 미채움으로 보고된다.
  assert.deepEqual(labels, ["기업명", "사업개요"]);
  assert.ok(unfilled.every((entry) => entry.reason.includes("확정되지 않아")), "정직한 사유 문구");
  assert.ok(!labels.includes("폐업여부"), "dismissed 는 사용자의 의도적 제외 — 보고 안 함");
  assert.ok(!labels.includes("매출액"), "확정값은 채움 대상 — 미채움 보고 대상 아님");
  assert.ok(!labels.includes("빈제안"), "빈 제안값은 보고 대상 아님");

  // fieldAnswers 미존재(미백필 draft)면 빈 목록 — 다운로드 흐름 회귀 없음.
  assert.deepEqual(listSuggestedUnfilled({ fieldAnswers: null, filledFields: {} }), []);
});

console.log(`\n✅ ${passed}개 통과`);

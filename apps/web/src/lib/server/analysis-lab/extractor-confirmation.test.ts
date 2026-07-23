// 자가신고 확인 질문(confirmation, lab-deep-v3) 정규화 단위 테스트 (순수 함수 — DB·네트워크·API 미사용).
// 실행: pnpm lab:confirmation:test
// 검증: ① 정상 통과(snake_case → camelCase) ② 극성 결손·옵션 수 미달·reusable 어휘 밖의 전체 드롭
// ③ per_notice 의 condition_key 강제 null ④ options value 중복 제거
// ⑤ 드롭·부재 시 criterion 은 필드 없이 유지(v2 이하 런 파일과 형태 동일 — 하위 호환).
import assert from "node:assert/strict";
import { normalizeConfirmation, normalizeCriteria } from "./extractor";

/** 정상 confirmation 응답 형태(도구 스키마의 snake_case) — 케이스별로 부분 덮어써 쓴다. */
function confirmationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "다른 정부지원사업에서 체계적합성시험비를 지원받은 적이 있나요?",
    options: [
      { value: "received_before", label: "지원받은 적이 있어요", disqualifies: true },
      { value: "never_received", label: "지원받은 적이 없어요", disqualifies: false },
    ],
    answer_type: "single",
    reusable: "company_fact",
    condition_key: "prior_award_system_conformity_test_fee",
    ...overrides,
  };
}

// ── ① 정상 통과 — snake_case 응답이 camelCase 계약으로 정규화된다 ────────────────────
{
  const normalized = normalizeConfirmation(confirmationFixture());
  assert.notEqual(normalized, null);
  assert.deepEqual(normalized, {
    prompt: "다른 정부지원사업에서 체계적합성시험비를 지원받은 적이 있나요?",
    options: [
      { value: "received_before", label: "지원받은 적이 있어요", disqualifies: true },
      { value: "never_received", label: "지원받은 적이 없어요", disqualifies: false },
    ],
    answerType: "single",
    reusable: "company_fact",
    conditionKey: "prior_award_system_conformity_test_fee",
  });

  // answer_type 이 어휘 밖이면 기본 "single" 로 보정(드롭 아님).
  assert.equal(normalizeConfirmation(confirmationFixture({ answer_type: "checkbox" }))?.answerType, "single");
  // 문자열 트림 — cleanString 관행.
  assert.equal(
    normalizeConfirmation(confirmationFixture({ prompt: "  질문 문장  " }))?.prompt,
    "질문 문장",
  );
  console.log("✅ 정상 통과 — snake_case → camelCase 정규화·answer_type 보정");
}

// ── ② 전체 드롭 사유 — 프롬프트 없음·극성 결손·옵션 수 미달·reusable 어휘 밖 ──────────
{
  assert.equal(normalizeConfirmation(undefined), null, "필드 부재(구 런 응답 형식) → null");
  assert.equal(normalizeConfirmation("문자열"), null, "객체 아님 → null");
  assert.equal(normalizeConfirmation(confirmationFixture({ prompt: "   " })), null, "빈 prompt → 전체 드롭");

  // disqualifies 한쪽 극성 부재 — true 만 있거나 false 만 있으면 질문으로 무의미.
  assert.equal(
    normalizeConfirmation(
      confirmationFixture({
        options: [
          { value: "a", label: "결격 A", disqualifies: true },
          { value: "b", label: "결격 B", disqualifies: true },
        ],
      }),
    ),
    null,
    "disqualifies=false 선택지 부재 → 전체 드롭",
  );
  assert.equal(
    normalizeConfirmation(
      confirmationFixture({
        options: [
          { value: "a", label: "통과 A", disqualifies: false },
          { value: "b", label: "통과 B", disqualifies: false },
        ],
      }),
    ),
    null,
    "disqualifies=true 선택지 부재 → 전체 드롭",
  );

  // 옵션 2개 미만 — 결함 옵션(빈 label·비 boolean disqualifies)이 드롭된 뒤 1개만 남는 경우 포함.
  assert.equal(
    normalizeConfirmation(
      confirmationFixture({ options: [{ value: "only", label: "하나뿐", disqualifies: true }] }),
    ),
    null,
    "옵션 1개 → 전체 드롭",
  );
  assert.equal(
    normalizeConfirmation(
      confirmationFixture({
        options: [
          { value: "ok", label: "정상", disqualifies: true },
          { value: "broken", label: "", disqualifies: false },
          { value: "broken2", label: "비 boolean", disqualifies: "yes" },
        ],
      }),
    ),
    null,
    "결함 옵션 드롭 후 1개 잔존 → 전체 드롭",
  );
  // 4개 초과(스키마 밖 응답) — 정규화도 독립적으로 거부한다.
  assert.equal(
    normalizeConfirmation(
      confirmationFixture({
        options: [
          { value: "a", label: "가", disqualifies: true },
          { value: "b", label: "나", disqualifies: false },
          { value: "c", label: "다", disqualifies: false },
          { value: "d", label: "라", disqualifies: false },
          { value: "e", label: "마", disqualifies: false },
        ],
      }),
    ),
    null,
    "옵션 5개 → 전체 드롭",
  );

  assert.equal(
    normalizeConfirmation(confirmationFixture({ reusable: "global_fact" })),
    null,
    "reusable 어휘 밖 → 전체 드롭",
  );
  console.log("✅ 전체 드롭 — 빈 prompt·극성 결손·옵션 2~4개 밖·reusable 어휘 밖");
}

// ── ③ condition_key — per_notice 강제 null · company_fact 만 유지 ────────────────────
{
  const perNotice = normalizeConfirmation(
    confirmationFixture({ reusable: "per_notice", condition_key: "should_be_ignored" }),
  );
  assert.equal(perNotice?.reusable, "per_notice");
  assert.equal(perNotice?.conditionKey, null, "per_notice 는 condition_key 가 와도 강제 null");

  const noKey = normalizeConfirmation(confirmationFixture({ condition_key: undefined }));
  assert.equal(noKey?.conditionKey, null, "company_fact 에 키 부재면 null(드롭 아님)");
  console.log("✅ condition_key — per_notice 강제 null·company_fact 부재 허용");
}

// ── ④ options value 중복 제거 — 첫 항목 유지 ─────────────────────────────────────────
{
  const deduped = normalizeConfirmation(
    confirmationFixture({
      options: [
        { value: "dup", label: "첫 번째(유지)", disqualifies: true },
        { value: "dup", label: "두 번째(중복 드롭)", disqualifies: false },
        { value: "other", label: "다른 값", disqualifies: false },
      ],
    }),
  );
  assert.deepEqual(
    deduped?.options.map((option) => [option.value, option.label]),
    [
      ["dup", "첫 번째(유지)"],
      ["other", "다른 값"],
    ],
    "같은 value 는 첫 항목만 유지",
  );
  console.log("✅ value 중복 제거 — 첫 항목 유지");
}

// ── ⑤ normalizeCriteria 병합 — 드롭·부재 시 필드 미설정(v2 이하 런과 형태 동일) ───────
{
  const inputText = "3) 타 정부지원사업에서 체계적합성시험비를 기 지원받은 경우";
  const baseRow = {
    dimension: "prior_award",
    kind: "exclusion",
    operator: "exists",
    value: { scope: "self" },
    confidence: 0.9,
    source_span: inputText,
  };

  // confirmation 자체가 없는 구 런 응답 형식 — criterion 은 필드 없이 통과.
  const legacy = normalizeCriteria([baseRow], inputText);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]!.spanVerified, true);
  assert.equal("confirmation" in legacy[0]!, false, "부재 시 undefined 설정이 아니라 필드 생략");

  // 유효 confirmation 은 criterion 에 병합된다.
  const withConfirmation = normalizeCriteria(
    [{ ...baseRow, confirmation: confirmationFixture() }],
    inputText,
  );
  assert.equal(withConfirmation[0]!.confirmation?.reusable, "company_fact");
  assert.equal(withConfirmation[0]!.confirmation?.options.length, 2);

  // 결함 confirmation 은 전체 드롭되지만 criterion 은 유지된다(질문 없는 결격 추출).
  const dropped = normalizeCriteria(
    [{ ...baseRow, confirmation: confirmationFixture({ reusable: "bogus" }) }],
    inputText,
  );
  assert.equal(dropped.length, 1, "confirmation 드롭이 criterion 드롭으로 번지지 않는다");
  assert.equal("confirmation" in dropped[0]!, false, "드롭 시에도 필드 생략(undefined 아님)");
  console.log("✅ normalizeCriteria 병합 — 부재/드롭은 필드 생략·criterion 유지");
}

console.log("\nconfirmation 정규화 테스트 전부 통과");

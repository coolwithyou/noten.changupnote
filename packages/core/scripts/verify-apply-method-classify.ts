import assert from "node:assert/strict";
import { classifyApplyMethods } from "../src/index.js";

// 구조화 키 조합 — truthy 값만 채널로 확정, 표준 순서로 정렬.
assert.deepEqual(
  classifyApplyMethods({
    online: "온라인 접수처 안내",
    email: "apply@k-startup.go.kr",
    fax: null,
    visit: null,
    postal: null,
    other: null,
  }),
  ["online", "email"],
);
assert.deepEqual(
  classifyApplyMethods({
    online: null,
    email: null,
    fax: "02-000-0000",
    visit: "서울시 강남구 접수처",
    postal: "등기우편 제출",
    other: null,
  }),
  ["fax", "visit", "postal"],
);

// 전채널 null(원천 API에 데이터 없음) → 빈 배열이 정답.
assert.deepEqual(
  classifyApplyMethods({
    online: null,
    email: null,
    fax: null,
    visit: null,
    postal: null,
    other: null,
  }),
  [],
);

// BizInfo text 자유텍스트 — 각 채널 키워드.
assert.deepEqual(classifyApplyMethods({ text: "온라인 접수 (구글폼)" }), ["online"]);
assert.deepEqual(classifyApplyMethods({ text: "누리집 신청하기" }), ["online"]);
assert.deepEqual(classifyApplyMethods({ text: "홈페이지 시스템 전산 접수" }), ["online"]);
assert.deepEqual(classifyApplyMethods({ text: "이메일 접수 (xxx@yyy.kr)" }), ["email"]);
assert.deepEqual(classifyApplyMethods({ text: "팩스(fax)로 제출" }), ["fax"]);
assert.deepEqual(classifyApplyMethods({ text: "방문 접수처 내방" }), ["visit"]);
assert.deepEqual(classifyApplyMethods({ text: "우편(등기) 접수" }), ["postal"]);

// 이메일 주소 패턴만으로도 email.
assert.deepEqual(classifyApplyMethods({ text: "제출처: help.desk@example.co.kr" }), ["email"]);

// "세부사업별 상이하므로 공고문 참조" — 키워드 미매칭 비어있지 않은 텍스트 → other.
assert.deepEqual(classifyApplyMethods({ text: "세부사업별 상이하므로 공고문 참조" }), ["other"]);

// "전자우편 접수" → email 만(전자우편의 "우편" postal 오탐 없음).
assert.deepEqual(classifyApplyMethods({ text: "전자우편 접수" }), ["email"]);
assert.deepEqual(classifyApplyMethods({ text: "전자우편(e-mail)로 신청" }), ["email"]);

// 복합 자유텍스트 — 여러 채널 동시 매칭 + 표준 순서 정렬.
assert.deepEqual(
  classifyApplyMethods({ text: "온라인 또는 방문·우편 접수" }),
  ["online", "visit", "postal"],
);

// other 키 자유텍스트도 분류 대상(K-Startup other).
assert.deepEqual(classifyApplyMethods({ other: "홈페이지에서 온라인 신청" }), ["online"]);
assert.deepEqual(classifyApplyMethods({ other: "담당자 문의 후 접수" }), ["other"]);

// 빈 객체 / undefined / null → 빈 배열.
assert.deepEqual(classifyApplyMethods({}), []);
assert.deepEqual(classifyApplyMethods(undefined), []);
assert.deepEqual(classifyApplyMethods(null), []);
// 공백 문자열은 truthy 아님.
assert.deepEqual(classifyApplyMethods({ text: "   " }), []);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "structured_keys",
    "channel_keywords",
    "all_null_empty",
    "other_fallback",
    "email_no_postal_false_positive",
    "email_address_pattern",
    "multi_channel_sorted",
    "empty_and_undefined",
  ],
}, null, 2));

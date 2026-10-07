import assert from "node:assert/strict";
import {
  writingCompositionEvidenceCount,
  writingCompositionText,
  writingParagraphKindLabels,
  type WritingComposition,
} from "./writingComposition";

// D3: 문단 종류 라벨은 문항별 문안 시트·작성 도우미 rail 공통 단일 원천이며 디자인 정본 어휘를 따른다.
assert.deepEqual(writingParagraphKindLabels, {
  company_fact: "회사 자료 기반",
  plan: "이번 사업 계획",
  proposal: "검토할 제안",
});

const composition: WritingComposition = {
  paragraphs: [
    { text: "2023년 설립된 도소매 기업입니다.", kind: "company_fact", evidence: [{ sourceId: "a", quote: "2023년 설립" }, { sourceId: "b", quote: "도소매업" }] },
    { text: "자사몰을 개편합니다.", kind: "plan", evidence: [{ sourceId: "c", quote: "자사몰 개편" }] },
    { text: "재구매율을 지표로 둡니다.", kind: "proposal", evidence: [] },
  ],
  questions: ["첫 출시 품목이 정해졌나요?"],
};

// "인용 근거 보기 · N건"의 N은 문단 전체의 인용 수 합계다.
assert.equal(writingCompositionEvidenceCount(composition), 3);
assert.equal(writingCompositionEvidenceCount({ paragraphs: [], questions: [] }), 0);

// 편집 칸으로 가져올 때 검토할 제안 문단에만 "검토 제안: " 접두가 붙는다.
const text = writingCompositionText(composition);
assert.equal(text.split("\n\n").length, 3);
assert.match(text, /검토 제안: 재구매율/);
assert.doesNotMatch(text, /검토 제안: 2023년/);

console.log("writingComposition: ok");

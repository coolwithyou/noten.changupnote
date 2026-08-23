import assert from "node:assert/strict";
import { verifyScheduleSuggestion } from "./scheduleSuggest";

const raw = {
  phases: [
    {
      title: "시제품 제작",
      startMonth: 7,
      endMonth: 8,
      basis: "작성 내용에 시제품 제작 목표가 있음",
      basisKind: "draft" as const,
      evidenceQuote: "시제품 제작",
      assumptions: [],
    },
    {
      title: "테스트 마켓 운영",
      startMonth: 9,
      endMonth: 10,
      basis: "시제품 뒤 시장 검증을 진행하는 실행 순서",
      basisKind: "recommendation" as const,
      evidenceQuote: "",
      assumptions: ["시제품 검증이 8월 안에 끝나는 일정으로 가정"],
    },
  ],
};

assert.deepEqual(verifyScheduleSuggestion({
  raw,
  months: [5, 6, 7, 8, 9, 10, 11, 12],
  maxPhases: 5,
  announcementCorpus: "사업기간은 협약일부터 12월까지입니다.",
  draftCorpus: "개발 목표: 시제품 제작 및 사용자 검증",
}), raw);

assert.equal(verifyScheduleSuggestion({
  raw: {
    phases: [{
      ...raw.phases[0]!,
      basisKind: "announcement",
      evidenceQuote: "원문에 없는 기간",
    }],
  },
  months: [5, 6, 7, 8],
  maxPhases: 5,
  announcementCorpus: "사업기간은 협약일부터 12월까지입니다.",
  draftCorpus: "개발 목표: 시제품 제작 및 사용자 검증",
}), null);

assert.equal(verifyScheduleSuggestion({
  raw: {
    phases: [{
      ...raw.phases[1]!,
      evidenceQuote: "근거처럼 보이는 문장",
    }],
  },
  months: [8, 9, 10],
  maxPhases: 5,
  announcementCorpus: "",
  draftCorpus: "",
}), null);

assert.equal(verifyScheduleSuggestion({
  raw: { phases: [raw.phases[0]!, raw.phases[1]!] },
  months: [7, 8, 9, 10],
  maxPhases: 1,
  announcementCorpus: "",
  draftCorpus: "시제품 제작",
}), null);

console.log("Schedule suggestion verification tests passed");

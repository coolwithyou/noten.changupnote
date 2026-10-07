import assert from "node:assert/strict";
import { assembleGrounding } from "../chat/grounding";
import { writingGuidanceSources } from "./writingGuidanceSources";
import { verifyWritingComposition } from "./sectionComposer";
const profileSummary = "[회사 확인 정보]\n- 매출: 2025년 1억원";
const lessonBlock = "예시: 매출 10억원인 회사의 확장 계획을 설명합니다.";
const grounding = assembleGrounding({ metaSummary: "공고", markdown: null, markdownFilename: null, lessonBlock, profileSummary,
  truncated: false, bodySourceMissing: true });
const sources = writingGuidanceSources(grounding, "company-a");
assert.equal(sources[0]!.kind, "company_profile");
assert.equal(sources[0]!.content.includes("10억원"), false);
assert.equal(sources[1]!.kind, "writing_guide");
assert.equal(sources[1]!.content, lessonBlock);
assert.throws(() => verifyWritingComposition({ paragraphs: [{ kind: "company_fact", text: "매출 10억원인 회사입니다.", evidence: [{ sourceId: sources[1]!.sourceId, quote: lessonBlock }] }], questions: [] }, sources));
assert.deepEqual(writingGuidanceSources({ profileSummary: "", lessonBlock: "" }, "company-a"), []);
console.log("PASS: writing guidance and company profiles remain separate evidence; example metrics in an approved guide cannot ground company facts");

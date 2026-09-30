import assert from "node:assert/strict";
import type { DocumentAgentGroundingSource } from "./documentAgentGrounding";
import { verifyWritingComposition, generateSectionSuggestions } from "./sectionComposer";
import { writingCompositionText } from "@/lib/documents/writingComposition";
import { emptyWritingBrief } from "@/lib/documents/writingContext";
const sources: DocumentAgentGroundingSource[] = [
  { sourceId: "company", kind: "company_material", title: "소개서", content: "2025년 고객 3곳에 서비스를 제공했고 매출은 1억원입니다.", sha256: "a".repeat(64), provenance: {} },
  { sourceId: "plan", kind: "application_plan", title: "계획", content: "2027년 고객 10곳 확보를 목표로 합니다.", sha256: "b".repeat(64), provenance: {} },
  { sourceId: "notice", kind: "announcement", title: "공고", content: "매출 10억원 이상 기업을 지원합니다.", sha256: "c".repeat(64), provenance: {} },
];
const fact = { text: "2025년 고객 3곳에 서비스를 제공했습니다.", kind: "company_fact", evidence: [{ sourceId: "company", quote: sources[0]!.content }] };
const plan = { text: "2027년 고객 10곳 확보를 목표로 합니다.", kind: "plan", evidence: [{ sourceId: "plan", quote: sources[1]!.content }] };
const verified = verifyWritingComposition({ paragraphs: [fact, plan, { text: "고객 인터뷰를 검토합니다.", kind: "proposal", evidence: [] }], questions: ["실제 추진 기간은 언제인가요?"] }, sources);
assert.match(writingCompositionText(verified), /\n\n/);
assert.match(writingCompositionText(verified), /검토 제안:/);
for (const paragraph of [
  { ...fact, evidence: [{ sourceId: "notice", quote: sources[2]!.content }] },
  { ...fact, evidence: [{ sourceId: "plan", quote: sources[1]!.content }] },
  { ...fact, text: "2025년 고객 30곳에 서비스를 제공했습니다." },
  { ...fact, text: "매출은 1조원입니다." },
  { ...fact, evidence: [{ sourceId: "other-company", quote: sources[0]!.content }] },
  { ...fact, evidence: [{ sourceId: "company", quote: "인증 보유" }] },
  { ...fact, evidence: [] },
  { ...plan, text: "2028년 고객 10곳 확보를 목표로 합니다." },
  { ...plan, evidence: [{ sourceId: "notice", quote: sources[2]!.content }] },
]) assert.throws(() => verifyWritingComposition({ paragraphs: [paragraph], questions: [] }, sources));
const noData = await generateSectionSuggestions({ draftId: crypto.randomUUID(), grantId: crypto.randomUUID(),
  access: { userId: crypto.randomUUID(), companyId: crypto.randomUUID(), role: "owner", mode: "session" },
  fieldLabel: "사업 목표", guidance: null, sourceSpan: null, writing: { revision: 0, brief: emptyWritingBrief(), sources: [] }, requestId: crypto.randomUUID(),
});
assert.equal(noData.composition.questions.length, 3);
assert.deepEqual(noData.suggestions, {});
console.log("PASS: section composition preserves paragraphs, separates fact/plan/proposal, rejects invented numbers/units/quotes and announcement-as-fact; empty context asks questions without provider/DB calls");

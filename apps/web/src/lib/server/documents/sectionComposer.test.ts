import assert from "node:assert/strict";
import type { DocumentAgentGroundingSource } from "./documentAgentGrounding";
import { verifyWritingComposition, generateSectionSuggestions, classifySectionFailure, sectionComposerSystemPrompt } from "./sectionComposer";
import { APICallError, NoObjectGeneratedError } from "ai";
import { WritingContextError } from "./writingContext";
import { sectionFailureMessage } from "@/lib/documents/sectionFailure";
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
const rejected = (raw: unknown, code: string) => assert.throws(() => verifyWritingComposition(raw, sources),
  (error: unknown) => error instanceof WritingContextError && error.code === code && error.message === sectionFailureMessage(code));
rejected({ paragraphs: [{ ...fact, text: "顧客 30곳" }], questions: [] }, "section_quantity_mismatch");
rejected({ paragraphs: [{ ...fact, evidence: [{ sourceId: "notice", quote: sources[2]!.content }] }], questions: [] }, "section_company_source_invalid");
rejected({ paragraphs: [{ ...fact, evidence: [] }], questions: [] }, "section_evidence_missing");
rejected({ paragraphs: [{ ...fact, evidence: [{ sourceId: "company", quote: "없는 인용문" }] }], questions: [] }, "section_evidence_invalid");
rejected({ paragraphs: [{ ...plan, evidence: [{ sourceId: "company", quote: sources[0]!.content }] }], questions: [] }, "section_plan_source_invalid");
rejected({ paragraphs: [{ ...fact, text: "회사\u0007내용" }], questions: [] }, "section_control_characters");
rejected({ paragraphs: "private-company-text" }, "section_output_invalid");
rejected({ paragraphs: Array.from({length:3},()=>({kind:"proposal",text:"가".repeat(1500),evidence:[]})), questions:[] }, "section_output_too_long");
assert.throws(() => verifyWritingComposition({paragraphs:[{kind:"company_fact",text:"추진합니다.",evidence:[{sourceId:"future",quote:"사업 추진 계획"}]}],questions:[]},
  [{...sources[0]!,sourceId:"future",content:"사업 추진 계획"}]), (error:unknown)=>error instanceof WritingContextError && error.code==="section_plan_as_fact");
const provider = new APICallError({message:"private-company-text API_KEY",url:"https://provider.invalid",requestBodyValues:{secret:"never expose"},statusCode:500});
assert.equal(classifySectionFailure(provider).code,"section_provider_unavailable");
assert.equal(classifySectionFailure(provider,true).code,"section_provider_timeout");
assert.equal(classifySectionFailure(new DOMException("private-company-text","AbortError")).code,"section_provider_timeout");
const malformed = new NoObjectGeneratedError({text:"private-company-text",response:{id:"synthetic",timestamp:new Date(),modelId:"synthetic"},usage:{} as never,finishReason:"stop"});
assert.equal(classifySectionFailure(malformed).code,"section_output_invalid");
for(const error of [provider,malformed,new Error("private-company-text API_KEY"),new WritingContextError("section_evidence_invalid","private-company-text")]) {
  assert.doesNotMatch(classifySectionFailure(error).message,/private-company-text|API_KEY|never expose/);
}
assert.equal(sectionFailureMessage("unknown-provider-detail"),sectionFailureMessage("section_generation_failed"));
const prompt = sectionComposerSystemPrompt();
for(const rule of [/company_profile, company_material, current_document/,/application_plan 또는 current_document/,/원문에서 그대로 복사/,/숫자와 단위/,/계산·합산·추정/]) assert.match(prompt,rule);
const noData = await generateSectionSuggestions({ draftId: crypto.randomUUID(), grantId: crypto.randomUUID(),
  access: { userId: crypto.randomUUID(), companyId: crypto.randomUUID(), role: "owner", mode: "session" },
  fieldLabel: "사업 목표", guidance: null, sourceSpan: null, writing: { revision: 0, brief: emptyWritingBrief(), sources: [] }, requestId: crypto.randomUUID(),
});
assert.equal(noData.composition.questions.length, 3);
assert.deepEqual(noData.suggestions, {});
console.log("PASS: section composition preserves paragraphs, separates fact/plan/proposal, rejects invented numbers/units/quotes and announcement-as-fact; empty context asks questions without provider/DB calls");

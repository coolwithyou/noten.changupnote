import assert from "node:assert/strict";
import type { DocumentAgentGroundingSource } from "./documentAgentGrounding";
import { verifyWritingComposition, generateSectionSuggestions, classifySectionFailure, sectionComposerSystemPrompt } from "./sectionComposer";
import { APICallError, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { WritingContextError } from "./writingContext";
import { sectionFailureMessage } from "@/lib/documents/sectionFailure";
import { buildSectionEvidenceUnits, resolveSectionEvidenceSelection, sectionEvidenceSelectionSchema } from "./sectionEvidenceUnits";
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
// Real source formats contain CRLF, line breaks and repeated spaces. An exact copied
// quote must pass the same canonical whitespace membership contract as other agents.
for (const kind of ["company_material", "application_plan", "current_document"] as const) {
  const content = "제품 소개:\r\n문서  처리\t서비스를 제공합니다.\n\n사용자 검토를 지원합니다.";
  const source = { ...sources[0]!, kind, sourceId: `multiline-${kind}`, content };
  const paragraph = { kind: kind === "application_plan" ? "plan" : "company_fact", text: "문서 처리 서비스를 제공합니다.",
    evidence: [{ sourceId: source.sourceId, quote: "문서  처리\t서비스를 제공합니다.\n\n사용자 검토를 지원합니다." }] };
  const composition = { paragraphs: [paragraph], questions: [] };
  assert.deepEqual(verifyWritingComposition(composition, [source]), composition);
  assert.equal(source.content, content); // Original source and SHA binding remain untouched.
  for (const ref of [
    {sourceId: source.sourceId, quote: "문서 처리 서비스를 제공하고 인증받았습니다."},
    {sourceId: "different-source", quote: paragraph.evidence[0]!.quote},
    {sourceId: source.sourceId, quote: "문서 처리 서비스를 제공합니다. 사용자 검토와 인증을 지원합니다."},
  ]) assert.throws(() => verifyWritingComposition({paragraphs:[{...paragraph,evidence:[ref]}],questions:[]},[source]),
    (error:unknown)=>error instanceof WritingContextError && error.code==="section_evidence_invalid");
}
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
for(const rule of [/company_profile, company_material, current_document/,/application_plan 또는 current_document/,/sourceId나 quote를 직접 생성하지 않습니다/,/숫자와 단위/,/계산·합산·추정/]) assert.match(prompt,rule);
const units = buildSectionEvidenceUnits(sources);
assert.deepEqual(buildSectionEvidenceUnits(sources), units);
for(const unit of units) {
  assert.equal(unit.quote, sources.find(source=>source.sourceId===unit.sourceId)!.content.slice(unit.start,unit.end));
  assert.ok(unit.quote.length<=500);
}
const companyUnit = units.find(unit=>unit.sourceId==="company")!;
const planUnit = units.find(unit=>unit.sourceId==="plan")!;
const announcementUnit = units.find(unit=>unit.sourceId==="notice")!;
const selected = (text:string, kind:string, evidenceIds:string[])=>({paragraphs:[{text,kind,evidenceIds}],questions:[]});
const selectedPlan = (primaryEvidenceId:string, supportingEvidenceIds:string[]=[])=>({paragraphs:[{text:plan.text,kind:"plan",primaryEvidenceId,supportingEvidenceIds}],questions:[]});
const resolveAndVerify = (value:unknown)=>verifyWritingComposition(resolveSectionEvidenceSelection(value,units),sources);
assert.deepEqual(resolveAndVerify(selected(fact.text,"company_fact",[companyUnit.evidenceId])).paragraphs[0]!.evidence,
  [{sourceId:"company",quote:companyUnit.quote}]);
assert.ok(sectionEvidenceSelectionSchema(units).safeParse(selected(fact.text,"company_fact",["unknown-unit"])).success===false);
assert.throws(()=>resolveAndVerify(selected(fact.text,"company_fact",["unknown-unit"])));
for(const invalid of [
  selected(fact.text,"company_fact",[announcementUnit.evidenceId]),
  selected(fact.text,"company_fact",[planUnit.evidenceId]),
  selected(fact.text,"company_fact",[]),
  selectedPlan(companyUnit.evidenceId),
  selected(plan.text,"plan",[planUnit.evidenceId]), // Old shape cannot bypass required primary.
  {paragraphs:[{text:plan.text,kind:"plan",supportingEvidenceIds:[planUnit.evidenceId]}],questions:[]},
]) assert.equal(sectionEvidenceSelectionSchema(units).safeParse(invalid).success,false);
assert.deepEqual(resolveAndVerify(selectedPlan(planUnit.evidenceId,[announcementUnit.evidenceId])).paragraphs[0]!.evidence,
  [{sourceId:"plan",quote:planUnit.quote},{sourceId:"notice",quote:announcementUnit.quote}]);
assert.throws(()=>resolveAndVerify(selected("2025년 고객 30곳에 서비스를 제공했습니다.","company_fact",[companyUnit.evidenceId])),
  (error:unknown)=>error instanceof WritingContextError && error.code==="section_quantity_mismatch");
const jsonSchema=z.toJSONSchema(sectionEvidenceSelectionSchema(units));
assert.match(JSON.stringify(jsonSchema),/"anyOf"/);
assert.doesNotMatch(JSON.stringify(jsonSchema),/"oneOf"/);
const futureSource={...sources[0]!,sourceId:"future-company",content:"2025년 고객 3곳에 제공합니다.\n앞으로 고객 10곳 확보를 계획합니다."};
const futureUnits=buildSectionEvidenceUnits([futureSource]);
assert.equal(futureUnits.length,2);
assert.throws(()=>verifyWritingComposition(resolveSectionEvidenceSelection(selected("고객을 확보했습니다.","company_fact",[futureUnits[1]!.evidenceId]),futureUnits),[futureSource]),
  (error:unknown)=>error instanceof WritingContextError && error.code==="section_output_invalid");
const announcementOnly=sectionEvidenceSelectionSchema([announcementUnit]);
assert.equal(announcementOnly.safeParse(selected(fact.text,"company_fact",[announcementUnit.evidenceId])).success,false);
assert.equal(announcementOnly.safeParse(selectedPlan(announcementUnit.evidenceId)).success,false);
assert.equal(announcementOnly.safeParse(selected("검토합니다.","proposal",[])).success,true);
assert.equal(sectionEvidenceSelectionSchema([companyUnit]).safeParse(selectedPlan(companyUnit.evidenceId)).success,false);
assert.equal(sectionEvidenceSelectionSchema([planUnit]).safeParse(selected(fact.text,"company_fact",[planUnit.evidenceId])).success,false);
const currentUnits=buildSectionEvidenceUnits([{...sources[0]!,kind:"current_document"}]);
assert.equal(sectionEvidenceSelectionSchema(currentUnits).safeParse(selectedPlan(currentUnits[0]!.evidenceId)).success,true);
const longSource={...sources[0]!,content:"가".repeat(498)+"😀"+"나".repeat(600)+"\r\n한국어 문장입니다. 다음 문장입니다."};
for(const unit of buildSectionEvidenceUnits([longSource])) {
  assert.ok(unit.quote.length<=500); assert.equal(unit.quote,longSource.content.slice(unit.start,unit.end));
  assert.doesNotMatch(unit.quote,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
}
assert.notEqual(buildSectionEvidenceUnits([{...sources[0]!,content:"바뀐 회사 내용"}])[0]!.evidenceId,companyUnit.evidenceId);
assert.deepEqual(resolveSectionEvidenceSelection(selected("검토합니다.","proposal",[]),[]).paragraphs[0]!.evidence,[]);
assert.equal(sectionEvidenceSelectionSchema([]).safeParse(selected("검토합니다.","proposal",["invented"])).success,false);
const noData = await generateSectionSuggestions({ draftId: crypto.randomUUID(), grantId: crypto.randomUUID(),
  access: { userId: crypto.randomUUID(), companyId: crypto.randomUUID(), role: "owner", mode: "session" },
  fieldLabel: "사업 목표", guidance: null, sourceSpan: null, writing: { revision: 0, brief: emptyWritingBrief(), sources: [] }, requestId: crypto.randomUUID(),
});
assert.equal(noData.composition.questions.length, 3);
assert.deepEqual(noData.suggestions, {});
console.log("PASS: section composition preserves paragraphs, separates fact/plan/proposal, rejects invented numbers/units/quotes and announcement-as-fact; empty context asks questions without provider/DB calls");

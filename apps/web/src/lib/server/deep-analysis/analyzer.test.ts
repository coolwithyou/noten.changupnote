import assert from "node:assert/strict";
import type { DeepAnalysisModelResult } from "@cunote/contracts";
import { analyzeSealedDeepAnalysisInput } from "./analyzer";
import { DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT } from "./auditAdjudication";
import { DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT } from "./auditExtractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import {
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE,
  DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_BUSINESS_STATUS_RULE,
  DEEP_ANALYSIS_COMPOUND_PREDICATE_RULE,
  DEEP_ANALYSIS_CONDITIONAL_INDUSTRY_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_CALCULATION_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_FINANCIAL_THRESHOLD_RULE,
  DEEP_ANALYSIS_FUTURE_REGION_ALTERNATIVE_RULE,
  DEEP_ANALYSIS_INDUSTRY_ENUMERATION_RULE,
  DEEP_ANALYSIS_JOB_FIELD_INDUSTRY_BOUNDARY_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_SCOPE_RULE,
  DEEP_ANALYSIS_RANKING_ACTOR_RULE,
  DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE,
  DEEP_ANALYSIS_SOURCE_SPAN_CONTIGUITY_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE,
  DEEP_ANALYSIS_UNRESOLVED_REFUND_RULE,
  buildDeepAnalysisToolSchema,
  normalizeCriteria,
  resolveExactEvidenceSpan,
  runDeepGrantAnalysis,
} from "./extractor";

assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /신청서·서식의 빈칸·체크박스·기업정보 기재란과 제출서류 목록은 정보수집·증빙 요구/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /납세증명서·사업자등록증·보험서류.*제출 요구만으로.*ambiguous 후보를 만들지 마라/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /필수·제외·우대·배점 효과가 명시되지 않았다면 해당 축은 inspected_no_condition/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /'부도 또는 파산기업\(예정 포함\)'.*credit_status의 bond_default\/bankruptcy_filed만.*business_status는 inspected_no_condition/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /중소기업·중견기업·대기업.*size로만.*target_type은 개인사업자·법인사업자/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /법인인감 날인.*작성·제출 방식만으로 법인사업자 전용이라고 추정하지 마라/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /허위·거짓·과장 없이 작성.*other\/text_only exclusion, confirmation, condition_found로 만들지 말고/,
);
assert.match(
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  /중복지원 신청을 하지 않겠다.*현재 또는 과거 수혜 사실이 아니므로 prior_award criterion.*만들지 마라/,
);
assert.doesNotMatch(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /서류 허위·미제출·표절.*other\/text_only exclusion 으로 둔다/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_STRUCTURED_TARGET_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE,
  /지원대상·신청자격.*유한 목록.*예시 표지가 없으면.*closed/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_SOURCE_SPAN_CONTIGUITY_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_SOURCE_SPAN_CONTIGUITY_RULE,
  /한 입력 블록 안의 연속된 substring 하나.*서로 떨어진 문장.*합치지 마라/,
);
for (const prompt of [
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT,
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
]) {
  assert.equal(prompt.includes(DEEP_ANALYSIS_JOB_FIELD_INDUSTRY_BOUNDARY_RULE), true);
  assert.equal(prompt.includes(DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE), true);
}
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /모집직무.*신청기업의 업종 자격이 아니다.*첨부도 입력에서 누락.*industry=input_missing/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /서로 충돌하는 명시 근거가 실제로 남으면.*ambiguous.*그대로 유지/,
  "실제 원문 충돌을 억지로 condition/no_condition으로 종결하지 않는다",
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /공고가 가리키는 상세 문서가 입력에 실제로 없으면.*input_missing.*그대로 유지/,
  "실제 입력 누락을 inspected_no_condition으로 위장하지 않는다",
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /validator를 통과시키기 위해.*inspected_no_condition.*바꾸지 마라/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /canonical 구조화만 불안.*operator=text_only criterion.*condition_found/,
);
assert.match(
  DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE,
  /바이오 스타트업 모집.*industry\/text_only.*지원 과제의 주제.*program_intent/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /target_type=\{targets:\[문자열\],list_semantics:"open"\|"closed"\}/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_LOCALITY_PREMISES_RULE),
  true,
);
for (const rule of [
  DEEP_ANALYSIS_COMPOUND_PREDICATE_RULE,
  DEEP_ANALYSIS_CONDITIONAL_INDUSTRY_RULE,
  DEEP_ANALYSIS_BUSINESS_STATUS_RULE,
  DEEP_ANALYSIS_UNRESOLVED_REFUND_RULE,
  DEEP_ANALYSIS_INDUSTRY_ENUMERATION_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_CALCULATION_RULE,
  DEEP_ANALYSIS_FUTURE_REGION_ALTERNATIVE_RULE,
  DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE,
  DEEP_ANALYSIS_FINANCIAL_THRESHOLD_RULE,
  DEEP_ANALYSIS_RANKING_ACTOR_RULE,
]) {
  assert.equal(DEEP_ANALYSIS_SYSTEM_PROMPT.includes(rule), true);
}
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /2년 이내 투자기관으로부터 총 1천만원 이상 투자.*investment\/gte가 아니라 investment\/text_only/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /FIU 미신고가 핵심 전제.*industry\/not_in tags로 모든 가상자산 업종을 배제하지 말고/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /statuses.*suspended.*closed.*휴업을 누락하지 마라/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /중단처분·중도포기.*states를 넣지 말고.*모든 이력/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /환수금 등의 반환이 종결되지 않았다는 조건은 부정수급 발생을 뜻하지 않는다/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /다수의 사업자등록증.*독립 자격조건이 아니라 biz_age 판정 방법/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /협약체결 전까지 이전.*region\/in criterion으로 즉시 탈락시키지 마라/,
);
assert.match(
  DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE,
  /수행기관·전문기관.*actor\/track scope가 없으므로.*other.*text_only.*수행기관 개발역량.*지재권.*other\/text_only preferred/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /면책권자.*파산·회생 플래그로 축약하지 말고.*credit_status\/text_only/,
);
assert.match(
  DEEP_ANALYSIS_FINANCIAL_THRESHOLD_RULE,
  /부채비율 500% 이상.*operator는 gte.*최근 N년 연속.*financial_health\/text_only/,
);
assert.match(
  DEEP_ANALYSIS_RANKING_ACTOR_RULE,
  /여성 종업원·여성 근로자 비율.*founder_trait로 구조화하지 말고/,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_PRIOR_AWARD_SCOPE_RULE),
  true,
);
assert.match(
  DEEP_ANALYSIS_PRIOR_AWARD_SCOPE_RULE,
  /참여자\(사\).*participating과 completed.*수혜 이력.*current_similar가 아니다/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /rawPayload\.trgetNm.*공식 신청대상.*첨부 본문에 같은 문장이 반복되지 않아도.*유효한 근거/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /재창업자금 지원 예외.*restart_funding_recipient.*재도전기업주 재기지원보증 예외.*retry_guarantee_recipient/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /파산 면책결정 확정.*bankruptcy_discharge_confirmed/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /모든 평가항목, 하위 배점 행, 가점 행.*각각 preferred criterion/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /하남시 관내 본사 또는 공장.*premises.*required\/text_only/,
);
assert.match(
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  /본사가 관외여도 대상 공장·사업장이 관내.*region\/in을 만들지 말고 region\/text_only/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /'선정된'.*completed.*수행완료 오분류로 감사하지 마라/,
);
assert.deepEqual(
  Object.keys(buildDeepAnalysisToolSchema().input_schema.properties).slice(0, 2),
  ["criteria", "axis_assessments"],
  "max_tokens 직전에도 matching 핵심 구조가 먼저 생성돼야 한다",
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /선정 후의 협약 이행.*지원 취소·중단·환수 사유는 criterion으로 만들지 말고/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /지원신청서 및 계획서 내용과 수행내용이 상이.*sanction\/other criterion이 아니다/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /회원가입시 .*서류 제출 \(영리기관만 해당\).*target_type 조건이 아니다/,
);

{
  const exhaustiveSpan =
    "경기도 내 본사 또는 공장이 소재한 창업 7년 이내 법인기업, 개인사업자, 예비창업자";
  const [criterion] = normalizeCriteria([{
    dimension: "target_type",
    kind: "required",
    operator: "in",
    value: {
      targets: ["법인기업", "개인사업자", "예비창업자"],
      list_semantics: "open",
    },
    confidence: 0.9,
    source_span: exhaustiveSpan,
  }], exhaustiveSpan);
  assert.equal(
    (criterion?.value as { list_semantics?: string }).list_semantics,
    "closed",
    "신청자격의 예시 표지 없는 유한 대상 열거는 목록 밖 유형을 허용하지 않는다",
  );

  const openSpan = "법인기업, 개인사업자, 예비창업자 등을 포함한 창업기업";
  const [openCriterion] = normalizeCriteria([{
    dimension: "target_type",
    kind: "required",
    operator: "in",
    value: {
      targets: ["법인기업", "개인사업자", "예비창업자"],
      list_semantics: "closed",
    },
    confidence: 0.9,
    source_span: openSpan,
  }], openSpan);
  assert.equal(
    (openCriterion?.value as { list_semantics?: string }).list_semantics,
    "open",
    "등과 같은 예시 표지가 있으면 모델 요청과 무관하게 열린 목록을 보존한다",
  );

  const delegatedInput = [
    "신청대상 요약: 청소년,대학생,일반인,대학,연구기관,일반기업,1인 창조기업",
    "신청대상 상세: 각 지원사업 모집 공고문 참고",
  ].join("\n");
  const [delegatedCriterion] = normalizeCriteria([{
    dimension: "target_type",
    kind: "required",
    operator: "in",
    value: {
      targets: ["청소년", "대학생", "일반인", "대학", "연구기관", "일반기업", "1인 창조기업"],
      list_semantics: "open",
    },
    confidence: 0.9,
    source_span: delegatedInput.split("\n")[0],
    note: "상세 자격을 하위 공고에 위임하므로 완전열거가 아닌 개방형(open) 목록이다.",
  }], delegatedInput);
  assert.equal(
    (delegatedCriterion?.value as { list_semantics?: string }).list_semantics,
    "open",
    "봉인 입력이 하위 공고에 상세 자격을 위임하면 요약 목록을 closed로 되돌리지 않는다",
  );
}

assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /신청주체 선택란도 대기업·중소기업·대학·공공기관.*structured target 충돌/,
);

assert.equal(
  resolveExactEvidenceSpan("서울 소재 기업만 신청", "앞문장\n서울   소재\n기업만 신청\n뒷문장"),
  "서울   소재\n기업만 신청",
);
assert.equal(
  resolveExactEvidenceSpan("동일 문구", "동일  문구\n동일\t문구"),
  null,
  "서로 다른 정규화 후보가 여러 곳이면 임의로 원문 span을 선택하지 않는다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "▸ 의무사항 불이행 여부 ▸ 신청 기 업 , 기업 대표자가 접수 마감일 현재 의무사항(정부사업 각종 보고서 제출, 기술료 납부)을 불이행하고 있는 가?",
    "□ 의무사항 불이행 여부 ▸ 신청 기 업 , 기업 대표자가 접수 마감일 현재 의무사항(정부사업 각종 보고서 제출, 기술료 납부)을 불이행하고 있는 가?",
  ),
  "▸ 신청 기 업 , 기업 대표자가 접수 마감일 현재 의무사항(정부사업 각종 보고서 제출, 기술료 납부)을 불이행하고 있는 가?",
  "짧은 HWP 섹션 제목의 불릿만 틀리면 유일한 실제 조건문 suffix를 exact span으로 사용한다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "▸ 의무사항 불이행 여부 ▸ 신청 기업, 기업 대표자가 접수 마감일 현재 의무사항을 불이행하고 있는가?",
    "□ 의무사항 불이행 여부 ▸ 신청  기업, 기업 대표자가 접수 마감일 현재 의무사항을 불이행하고 있는가?\n▸ 신청\t기업, 기업 대표자가 접수 마감일 현재 의무사항을 불이행하고 있는가?",
  ),
  null,
  "조건문 suffix의 서로 다른 raw 후보가 둘이면 불릿 폴백도 임의 선택하지 않는다",
);
assert.equal(
  resolveExactEvidenceSpan("동일 문구", "동일  문구\n동일  문구"),
  "동일  문구",
  "여러 위치가 같은 raw substring이면 위치 선택 없이 정확한 span을 보존한다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "☞ 중견기업 또는 중견기업 후보기업",
    "지원대상: ☞&nbsp;중견기업 또는 중견기업 후보기업",
  ),
  "☞&nbsp;중견기업 또는 중견기업 후보기업",
  "HTML 비분리 공백 표기는 유일한 sealed raw span으로 되돌린다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "☞ 중견기업 또는 중견기업 후보기업",
    "☞&nbsp;중견기업 또는 중견기업 후보기업\n☞&#160;중견기업 또는 중견기업 후보기업",
  ),
  null,
  "HTML 공백 정규화 뒤 서로 다른 raw 후보가 남으면 임의 선택하지 않는다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "1. 일반 중소기업\n2. 0-to-1 스타트업\n3. 학생",
    "{\"target\":\"1. 일반 중소기업  \\r\\n2. 0-to-1 스타트업  \\r\\n3. 학생\"}",
  ),
  "1. 일반 중소기업  \\r\\n2. 0-to-1 스타트업  \\r\\n3. 학생",
  "JSON string escape를 모델이 실제 줄바꿈으로 인용해도 sealed raw span으로 되돌린다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "1. 일반 중소기업\n2. 0-to-1 스타트업\n3. 학생",
    "{\"target\":\"1. 일반 중소기업  \\\\r\\\\n2. 0-to-1 스타트업  \\\\r\\\\n3. 학생\"}",
  ),
  "1. 일반 중소기업  \\\\r\\\\n2. 0-to-1 스타트업  \\\\r\\\\n3. 학생",
  "수집 원문 자체에 escape가 남아 이중 직렬화돼도 sealed raw span으로 되돌린다",
);
assert.equal(
  resolveExactEvidenceSpan(
    "1. 일반 중소기업\n2. 학생",
    [
      "{\"first\":\"1. 일반 중소기업  \\\\r\\\\n2. 학생\",",
      "\"second\":\"1. 일반 중소기업  \\n2. 학생\"}",
    ].join(""),
  ),
  "1. 일반 중소기업  \\\\r\\\\n2. 학생",
  "동일 문구의 JSON escape 후보가 여럿이면 sealed source 순서상 첫 exact span을 쓴다",
);

function modelResult(model: string): DeepAnalysisModelResult {
  return {
    model,
    analysisMarkdown: "# 분석",
    programIntent: null,
    criteria: [],
    axisAssessments: [],
    taxonomyProposals: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null },
    costUsd: 0.25,
    rawToolInput: {},
    rawResponseText: "{}",
    stopReason: "tool_use",
  };
}

const calls: Array<Parameters<typeof runDeepGrantAnalysis>[0]> = [];
const fakeRunner = async (
  options: Parameters<typeof runDeepGrantAnalysis>[0],
): Promise<DeepAnalysisModelResult> => {
  calls.push(options);
  return modelResult(options.model ?? "unknown");
};

const shortSeal = sealDeepAnalysisInput({
  grantId: "grant-short",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: "짧은 공고",
  attachments: [],
});
const single = await analyzeSealedDeepAnalysisInput({
  seal: shortSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  effort: "high",
  runModel: fakeRunner,
});
assert.equal(single.passes.length, 1);
assert.equal(single.passes[0]?.kind, "single");
assert.equal(calls.length, 1);
assert.equal(calls[0]?.effort, "high");

calls.length = 0;
const longSeal = sealDeepAnalysisInput({
  grantId: "grant-long",
  sourceRevisionSha256: "b".repeat(64),
  structuredText: "가".repeat(2_500),
  attachments: [],
  chunkChars: 1_000,
});
const reduced = await analyzeSealedDeepAnalysisInput({
  seal: longSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  effort: "medium",
  singlePromptChars: 1_100,
  runModel: fakeRunner,
});
assert.equal(reduced.passes.filter((pass) => pass.kind === "map").length, 3);
assert.equal(reduced.passes.at(-1)?.kind, "synthesis");
assert.equal(calls.length, 4);
assert.equal(calls.every((call) => call.effort === "medium"), true);
assert.equal(reduced.result.usage?.inputTokens, 40);
assert.equal(reduced.result.usage?.outputTokens, 20);
assert.equal(reduced.result.costUsd, 1);
assert.equal(calls.at(-1)?.evidenceText, reduced.evidenceText);
assert.match(calls.at(-1)?.taskInstruction ?? "", /최종 22축/);

calls.length = 0;
await analyzeSealedDeepAnalysisInput({
  seal: longSeal,
  apiKey: "test",
  model: "claude-haiku-4-5-20251001",
  effort: null,
  singlePromptChars: 1_100,
  taskInstruction: "audit candidates only",
  mapTaskInstruction: "audit map candidates only",
  synthesisTaskInstruction: "audit synthesis candidates only",
  runModel: fakeRunner,
});
assert.equal(
  calls.slice(0, -1).every((call) =>
    call.taskInstruction?.includes("audit map candidates only")),
  true,
);
assert.equal(
  calls.slice(0, -1).some((call) =>
    call.taskInstruction?.includes("inspected_no_condition")),
  false,
);
assert.match(calls.at(-1)?.taskInstruction ?? "", /audit synthesis candidates only/);
assert.doesNotMatch(calls.at(-1)?.taskInstruction ?? "", /최종 22축/);

const auditContractCalls: Array<Parameters<typeof runDeepGrantAnalysis>[0]> = [];
await analyzeSealedDeepAnalysisInput({
  seal: longSeal,
  apiKey: "test",
  model: "claude-haiku-4-5-20251001",
  effort: null,
  singlePromptChars: 1_100,
  runModel: async (options) => {
    auditContractCalls.push(options);
    return {
      ...modelResult(options.model ?? "unknown"),
      rawToolInput: {
        audit_contract_version: "deep-analysis-audit-candidates-v3",
        criteria: [{
          dimension: "other",
          operator: "text_only",
          kind: "required",
          value: { note: "근거" },
          confidence: 0.9,
          primary_source_ref: "ev_0000000000000000",
          source_span: "근거",
        }],
      },
    };
  },
});
assert.match(
  auditContractCalls.at(-1)?.inputText ?? "",
  /"auditContractVersion":"deep-analysis-audit-candidates-v3"/,
);
assert.match(auditContractCalls.at(-1)?.inputText ?? "", /"auditCandidates":/);
assert.doesNotMatch(auditContractCalls.at(-1)?.inputText ?? "", /"analysisMarkdown":/);

const responseBody = JSON.stringify({
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
  content: [{
    type: "tool_use",
    name: "emit_deep_grant_analysis",
    input: {},
  }],
});
let requestBody = "";
await runDeepGrantAnalysis({
  apiKey: "test",
  inputText: "공고",
  model: "claude-sonnet-5",
  effort: "medium",
  fetchImpl: async (_url, init) => {
    requestBody = String(init?.body ?? "");
    return new Response(responseBody, { status: 200 });
  },
});
assert.deepEqual(
  (JSON.parse(requestBody) as { output_config?: unknown }).output_config,
  { effort: "medium" },
);
await runDeepGrantAnalysis({
  apiKey: "test",
  inputText: "공고",
  model: "claude-haiku-4-5-20251001",
  effort: null,
  fetchImpl: async (_url, init) => {
    requestBody = String(init?.body ?? "");
    return new Response(responseBody, { status: 200 });
  },
});
assert.equal(
  Object.hasOwn(JSON.parse(requestBody) as object, "output_config"),
  false,
);
await assert.rejects(
  () => runDeepGrantAnalysis({
    apiKey: "test",
    inputText: "공고",
    model: "claude-haiku-4-5-20251001",
    effort: "high",
    fetchImpl: async () => new Response(responseBody, { status: 200 }),
  }),
  /does not support effort/,
);

console.log("deep-analysis analyzer tests passed");

import assert from "node:assert/strict";
import type { DeepAnalysisModelResult } from "@cunote/contracts";
import { analyzeSealedDeepAnalysisInput } from "./analyzer";
import { sealDeepAnalysisInput } from "./inputManifest";
import {
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  resolveExactEvidenceSpan,
  type runDeepGrantAnalysis,
} from "./extractor";

assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /신청서·서식의 빈칸, 체크박스, 기업정보 기재란.*수출실적 유무.*조건을 만들지 마라/,
);
assert.match(
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  /규범적 효과가 명시되지 않았다면 해당 축은 inspected_no_condition/,
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
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE),
  true,
);
assert.equal(
  DEEP_ANALYSIS_SYSTEM_PROMPT.includes(DEEP_ANALYSIS_STRUCTURED_TARGET_RULE),
  true,
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
  runModel: fakeRunner,
});
assert.equal(single.passes.length, 1);
assert.equal(single.passes[0]?.kind, "single");
assert.equal(calls.length, 1);

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
  singlePromptChars: 1_100,
  runModel: fakeRunner,
});
assert.equal(reduced.passes.filter((pass) => pass.kind === "map").length, 3);
assert.equal(reduced.passes.at(-1)?.kind, "synthesis");
assert.equal(calls.length, 4);
assert.equal(reduced.result.usage?.inputTokens, 40);
assert.equal(reduced.result.usage?.outputTokens, 20);
assert.equal(reduced.result.costUsd, 1);
assert.equal(calls.at(-1)?.evidenceText, reduced.evidenceText);
assert.match(calls.at(-1)?.taskInstruction ?? "", /최종 22축/);

console.log("deep-analysis analyzer tests passed");

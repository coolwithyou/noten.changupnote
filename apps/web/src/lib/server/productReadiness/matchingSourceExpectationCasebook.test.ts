import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria } from "@cunote/core";
import type { LabCriterion } from "@/lib/server/analysis-lab/lab-contract";
import { convertSelectedLabCriteria } from "@/lib/server/analysis-lab/shadow-convert";

type ExpectedMatrix = readonly [
  first: "eligible" | "conditional" | "ineligible",
  second: "eligible" | "conditional" | "ineligible",
  third: "eligible" | "conditional" | "ineligible",
];

type SourceTruthMatrix = readonly [
  first: "satisfied" | "unsatisfied" | "information_missing",
  second: "satisfied" | "unsatisfied" | "information_missing",
  third: "satisfied" | "unsatisfied" | "information_missing",
];

type SourceEvidence =
  | {
      kind: "artifact";
      artifactPath: string;
      artifactSha256: string;
      inputSha256: string;
      criterionIndexes: readonly number[];
    }
  | { kind: "synthetic"; rationale: string };

interface SourceExpectationCase {
  id: string;
  scope: "fixed" | "intentional_unknown_stage_2";
  sourceEvidence: SourceEvidence;
  profileLabels: readonly [string, string, string];
  sourceTruthExpected: SourceTruthMatrix;
  sourceCriterion: LabCriterion;
  beforeCriterion: GrantCriterion;
  companies: readonly [CompanyProfile, CompanyProfile, CompanyProfile];
  softwareExpectedBefore: ExpectedMatrix;
  softwareExpectedAfter: ExpectedMatrix;
  confirmations?: boolean;
  expectedProjectedCount?: number;
  expectedConversionStatus?: "converted" | "downgraded" | "scope_rejected";
  expectedConversionReason?: string | null;
}

const knownNoSanction: CompanyProfile = {
  sanction: { flags: [], known_flags: ["participation_restricted"], exceptions: [] },
  confidence: { sanction: 0.95 },
};
const knownCurrentSanction: CompanyProfile = {
  sanction: {
    flags: ["participation_restricted"],
    known_flags: ["participation_restricted"],
    exceptions: [],
  },
  confidence: { sanction: 0.95 },
};

const cases: SourceExpectationCase[] = [
  {
    id: "biz-age-under-three-correct-max-35",
    scope: "fixed",
    sourceEvidence: {
      kind: "synthetic",
      rationale: "정수 월 계약으로 표현 가능한 독립 정답(max_months=35) 경계 fixture",
    },
    profileLabels: ["업력 35개월", "업력 36개월", "업력 정보 없음"],
    sourceTruthExpected: ["satisfied", "unsatisfied", "information_missing"],
    sourceCriterion: labCriterion({
      dimension: "biz_age",
      kind: "required",
      operator: "lte",
      value: { max_months: 35 },
      sourceSpan: "업력 3년 미만 기업",
    }),
    beforeCriterion: grantCriterion({
      dimension: "biz_age",
      kind: "required",
      operator: "lte",
      value: { max_months: 35 },
      source_span: "업력 3년 미만 기업",
    }),
    companies: [{ biz_age_months: 35 }, { biz_age_months: 36 }, {}],
    softwareExpectedBefore: ["eligible", "ineligible", "conditional"],
    softwareExpectedAfter: ["eligible", "ineligible", "conditional"],
  },
  {
    id: "biz-age-under-three-historical-max-36-conflict",
    scope: "fixed",
    sourceEvidence: {
      kind: "artifact",
      artifactPath: "spike-out/analysis-lab/kstartup__178970/run-2026-09-05T090105.891Z-485180.json",
      artifactSha256: "3d84edf50e8b2091f8e68fd32a84b4fde8e76199f93fce108b2c72c8b3390500",
      inputSha256: "8b7c0e5daccbb56986c00cce2b947b5d75efab5fb796af42688e107b5c725aa3",
      criterionIndexes: [3],
    },
    profileLabels: ["업력 35개월", "업력 36개월", "업력 정보 없음"],
    sourceTruthExpected: ["satisfied", "unsatisfied", "information_missing"],
    sourceCriterion: labCriterion({
      dimension: "biz_age",
      kind: "required",
      operator: "lte",
      value: { max_months: 36 },
      sourceSpan: "업력 조건: 3년미만",
    }),
    beforeCriterion: grantCriterion({
      dimension: "biz_age",
      kind: "required",
      operator: "lte",
      value: { max_months: 36 },
      source_span: "업력 조건: 3년미만",
    }),
    companies: [{ biz_age_months: 35 }, { biz_age_months: 36 }, {}],
    softwareExpectedBefore: ["eligible", "eligible", "conditional"],
    softwareExpectedAfter: ["conditional", "conditional", "conditional"],
  },
  {
    id: "goyang-hq-branch-research-center-or",
    scope: "intentional_unknown_stage_2",
    sourceEvidence: {
      kind: "artifact",
      artifactPath: "spike-out/analysis-lab/kstartup__179003/run-2026-09-04T234609.098Z-f99950.json",
      artifactSha256: "a2e24b575740b27de40282243b60f9243968896428530f8fbd66c3028ebc451a",
      inputSha256: "7e497ad67d977bb8da6cbf429411ac46e6759c0317d20f930053ae1e066e6ea7",
      criterionIndexes: [0, 1],
    },
    profileLabels: ["서울 본사 + 고양 지사", "서울 본사만 있음", "사업장 정보 없음"],
    sourceTruthExpected: ["satisfied", "unsatisfied", "information_missing"],
    sourceCriterion: labCriterion({
      dimension: "region",
      kind: "required",
      operator: "text_only",
      value: {
        note: "고양시(경기) 소재 기업이어야 하나, 본사뿐 아니라 지사·연구소가 고양시에 있는 경우도 인정된다.",
      },
      sourceSpan: "- 투자유치를 희망하는 고양시 소재(지사, 연구소 포함) 기업",
    }),
    beforeCriterion: grantCriterion({
      dimension: "region",
      kind: "required",
      operator: "text_only",
      value: {
        note: "고양시(경기) 소재 기업이어야 하나, 본사뿐 아니라 지사·연구소가 고양시에 있는 경우도 인정된다.",
      },
      source_span: "- 투자유치를 희망하는 고양시 소재(지사, 연구소 포함) 기업",
    }),
    companies: [
      {
        region: { code: "11", label: "서울" },
        other_conditions: { headquarters_city: "서울", branch_city: "고양시" },
      },
      {
        region: { code: "11", label: "서울" },
        other_conditions: { headquarters_city: "서울" },
      },
      {},
    ],
    softwareExpectedBefore: ["conditional", "conditional", "conditional"],
    softwareExpectedAfter: ["conditional", "conditional", "conditional"],
  },
  {
    id: "current-participation-sanction",
    scope: "fixed",
    sourceEvidence: {
      kind: "artifact",
      artifactPath: "spike-out/analysis-lab/bizinfo__PBLN_000000000125687/run-2026-09-05T004332.590Z-726dc8.json",
      artifactSha256: "931672ea80557fbee5fbed81f19f88294826498fefc48ff1a76ba565eb20574f",
      inputSha256: "6c6aafa5b3ac3cb2f17b11b14b1dc109fa6a156beb3f78ad1d89b7f4140606ff",
      criterionIndexes: [13],
    },
    profileLabels: ["현재 참여제한 없음", "현재 참여제한 중", "제재 정보 없음"],
    sourceTruthExpected: ["satisfied", "unsatisfied", "information_missing"],
    sourceCriterion: labCriterion({
      dimension: "sanction",
      kind: "exclusion",
      operator: "in",
      value: { flags: ["participation_restricted"] },
      sourceSpan: "⑨ 공고일 현재 신청기업 및 신청기업의 대표가 정부지원사업에 참여제한 등의 제재를 받고 있는 경우",
    }),
    beforeCriterion: grantCriterion({
      dimension: "sanction",
      kind: "exclusion",
      operator: "in",
      value: { flags: ["participation_restricted"] },
      source_span: "⑨ 공고일 현재 신청기업 및 신청기업의 대표가 정부지원사업에 참여제한 등의 제재를 받고 있는 경우",
    }),
    companies: [knownNoSanction, knownCurrentSanction, {}],
    softwareExpectedBefore: ["eligible", "ineligible", "conditional"],
    softwareExpectedAfter: ["eligible", "ineligible", "conditional"],
  },
  {
    id: "agreement-breach-cause-is-not-independent-current-sanction",
    scope: "fixed",
    sourceEvidence: {
      kind: "artifact",
      artifactPath: "spike-out/analysis-lab/kstartup__179003/run-2026-09-04T234609.098Z-f99950.json",
      artifactSha256: "a2e24b575740b27de40282243b60f9243968896428530f8fbd66c3028ebc451a",
      inputSha256: "7e497ad67d977bb8da6cbf429411ac46e6759c0317d20f930053ae1e066e6ea7",
      criterionIndexes: [8],
    },
    profileLabels: ["두 제재 모두 없음", "현재 참여제한 중", "과거 협약위반만 있고 현재 제한 없음"],
    sourceTruthExpected: ["satisfied", "unsatisfied", "satisfied"],
    sourceCriterion: labCriterion({
      dimension: "sanction",
      kind: "exclusion",
      operator: "in",
      value: { flags: ["agreement_breach", "participation_restricted"] },
      sourceSpan: "○ 진흥원과의 협약 및 계약 위반 등으로 참여 제한 조치 중인 경우",
    }),
    beforeCriterion: grantCriterion({
      dimension: "sanction",
      kind: "exclusion",
      operator: "in",
      value: { flags: ["agreement_breach", "participation_restricted"] },
      source_span: "○ 진흥원과의 협약 및 계약 위반 등으로 참여 제한 조치 중인 경우",
    }),
    companies: [
      {
        sanction: {
          flags: [],
          known_flags: ["agreement_breach", "participation_restricted"],
          exceptions: [],
        },
        confidence: { sanction: 0.95 },
      },
      {
        sanction: {
          flags: ["participation_restricted"],
          known_flags: ["agreement_breach", "participation_restricted"],
          exceptions: [],
        },
        confidence: { sanction: 0.95 },
      },
      {
        sanction: {
          flags: ["agreement_breach"],
          known_flags: ["agreement_breach", "participation_restricted"],
          exceptions: [],
        },
        confidence: { sanction: 0.95 },
      },
    ],
    softwareExpectedBefore: ["eligible", "ineligible", "ineligible"],
    softwareExpectedAfter: ["conditional", "conditional", "conditional"],
    expectedConversionStatus: "downgraded",
    expectedConversionReason: "sanction_cause_state_flattening",
  },
  {
    id: "required-narrative-confirmation-does-not-auto-pass",
    scope: "intentional_unknown_stage_2",
    sourceEvidence: {
      kind: "synthetic",
      rationale: "2단계 전 required text_only의 미확인 자동 pass 방지 fixture",
    },
    profileLabels: ["상근 확인값 true", "상근 확인값 false", "상근 정보 없음"],
    sourceTruthExpected: ["satisfied", "unsatisfied", "information_missing"],
    sourceCriterion: labCriterion({
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "대표자 상근 여부 확인" },
      sourceSpan: "대표자는 사업 기간 동안 상근하여야 한다",
    }),
    beforeCriterion: grantCriterion({
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "대표자 상근 여부 확인" },
      source_span: "대표자는 사업 기간 동안 상근하여야 한다",
    }),
    companies: [
      { other_conditions: { representative_full_time: true } },
      { other_conditions: { representative_full_time: false } },
      {},
    ],
    softwareExpectedBefore: ["conditional", "conditional", "conditional"],
    softwareExpectedAfter: ["conditional", "conditional", "conditional"],
  },
  {
    id: "official-source-correction-overrides-confirmation",
    scope: "fixed",
    sourceEvidence: {
      kind: "synthetic",
      rationale: "공식 원천 정정(source_disputes)이 사용자 확인보다 우선하는 제품 규칙 fixture",
    },
    profileLabels: ["정정분쟁 + 제재 없음", "정정분쟁 + 현재제재", "정정분쟁 + 정보 없음"],
    sourceTruthExpected: ["information_missing", "information_missing", "information_missing"],
    sourceCriterion: labCriterion({
      dimension: "sanction",
      kind: "exclusion",
      operator: "in",
      value: { flags: ["participation_restricted"] },
      sourceSpan: "현재 참여제한 조치 중인 기업은 제외",
    }),
    beforeCriterion: grantCriterion({
      id: "before-source-correction",
      dimension: "sanction",
      kind: "exclusion",
      operator: "in",
      value: { flags: ["participation_restricted"] },
      source_span: "현재 참여제한 조치 중인 기업은 제외",
    }),
    companies: [
      { ...knownNoSanction, source_disputes: ["sanction"] },
      { ...knownCurrentSanction, source_disputes: ["sanction"] },
      { source_disputes: ["sanction"] },
    ],
    softwareExpectedBefore: ["conditional", "conditional", "conditional"],
    softwareExpectedAfter: ["conditional", "conditional", "conditional"],
    confirmations: true,
  },
];

for (const item of cases) {
  const conversion = convertSelectedLabCriteria({
    runId: `run-${item.id}`,
    grantId: `grant-${item.id}`,
    sourceId: item.id,
    criteria: [item.sourceCriterion],
  }, {
    selections: [{ criterionIndex: 0, needsReview: false }],
  });
  assert.equal(conversion.report.error, null, `${item.id}: 변환 error`);
  assert.equal(
    conversion.criteria.length,
    item.expectedProjectedCount ?? 1,
    `${item.id}: 변환 criterion 수`,
  );
  if (item.expectedConversionStatus) {
    assert.equal(conversion.report.items?.[0]?.status, item.expectedConversionStatus);
    assert.equal(
      conversion.report.items?.[0]?.reason,
      item.expectedConversionReason ?? null,
    );
  }
  const before = item.companies.map((company) => matchGrantCriteria(
    [item.beforeCriterion],
    company,
    item.confirmations
      ? { confirmations: [{ criterion_id: item.beforeCriterion.id!, disqualified: false }] }
      : {},
  ).eligibility);
  const after = item.companies.map((company) => matchGrantCriteria(
    conversion.criteria,
    company,
    item.confirmations && conversion.criteria[0]
      ? { confirmations: [{ criterion_id: conversion.criteria[0].id!, disqualified: false }] }
      : {},
  ).eligibility);
  assert.deepEqual(before, item.softwareExpectedBefore, `${item.id}: 원본 matcher 기대`);
  assert.deepEqual(after, item.softwareExpectedAfter, `${item.id}: 공용 projection matcher 기대`);
  assert.equal(item.profileLabels.length, item.sourceTruthExpected.length, `${item.id}: 원문 정답 profile 결속`);
  if (item.sourceEvidence.kind === "artifact") {
    assert.match(item.sourceEvidence.artifactSha256, /^[a-f0-9]{64}$/u, `${item.id}: artifact SHA`);
    assert.match(item.sourceEvidence.inputSha256, /^[a-f0-9]{64}$/u, `${item.id}: input SHA`);
    assert.ok(item.sourceEvidence.criterionIndexes.length > 0, `${item.id}: 원본 criterion index`);
  }
  if (item.scope === "intentional_unknown_stage_2") {
    assert.ok(after.every((value) => value === "conditional"), `${item.id}: 2단계 전 자동 pass 금지`);
  }
}

assert.equal(
  cases.find((item) => item.id === "biz-age-under-three-historical-max-36-conflict")
    ?.sourceCriterion.sourceSpan,
  "업력 조건: 3년미만",
  "고정 원문 fixture",
);

console.log(`matching source expectation casebook: ${cases.length} cases passed`);

function labCriterion(input: Partial<LabCriterion> & Pick<
  LabCriterion,
  "dimension" | "kind" | "operator" | "value"
>): LabCriterion {
  return {
    confidence: 0.9,
    sourceSpan: null,
    spanVerified: false,
    note: null,
    ...input,
  };
}

function grantCriterion(
  input: Omit<GrantCriterion, "confidence"> & { confidence?: number },
): GrantCriterion {
  return {
    ...input,
    confidence: input.confidence ?? 0.9,
    needs_review: false,
  };
}

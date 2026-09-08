import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CompanyProfile } from "@cunote/contracts";
import { matchGrantCriteria } from "@cunote/core";
import type { LabCriterion } from "@/lib/server/analysis-lab/lab-contract";
import { convertSelectedLabCriteria } from "@/lib/server/analysis-lab/shadow-convert";

interface SourceArtifactProvenance {
  artifactPath: string;
  artifactSha256: string;
  inputSha256: string;
  grantId: string;
  runId: string;
  source: "bizinfo" | "kstartup";
  sourceId: string;
  criterionIndex: number;
}

interface ReservedDimensionSourceCase {
  id: string;
  provenance: SourceArtifactProvenance;
  sourceExcerptSha256: string;
  criterion: LabCriterion;
  profiles: readonly CompanyProfile[];
  expectedEligibility: readonly ("eligible" | "conditional" | "ineligible")[];
}

/**
 * 운영 원문 전체를 복제하지 않고, 의미 보존에 필요한 criterion 한 건과 immutable source
 * artifact 결속만 고정한다. sourceExcerptSha256은 provenance+criterion 최소 excerpt의
 * canonical SHA다. 원 artifact가 로컬에 있으면 raw SHA와 excerpt를 다시 대조한다.
 */
const cases: readonly ReservedDimensionSourceCase[] = [
  {
    id: "city-site-and-notice-date-are-not-broad-region",
    provenance: {
      artifactPath: "spike-out/analysis-lab/bizinfo__PBLN_000000000125630/run-2026-08-30T235343.377Z-42d789.json",
      artifactSha256: "11a7816514090c2d06239798cb74da0030d37cd8cc80215bbe9b4a0c1cebf2e0",
      inputSha256: "e35f3a601dadcbf06e4adccbd70c14545a09edf66a59b00a7b2555a712e4cb79",
      grantId: "c6186084-4cf9-4b61-b718-68e3f523d974",
      runId: "run-2026-08-30T235343.377Z-42d789",
      source: "bizinfo",
      sourceId: "PBLN_000000000125630",
      criterionIndex: 2,
    },
    sourceExcerptSha256: "5734aa43209a4acc1bf1a6e681d5eb575c9d0ead5b3f248dcf372b7bfc902bd8",
    criterion: {
      dimension: "premises",
      kind: "required",
      operator: "text_only",
      value: {
        note: "공고일 기준 사업자등록증상의 주소지로 김해시에 본사 또는 공장 중 하나가 소재해야 한다.",
      },
      confidence: 0.9,
      sourceSpan: "☞ 공고일 기준 김해시(사업자등록증상의 주소지)에 본사 또는 공장이 소재하고",
      spanVerified: true,
      note: "시도 코드로 표현되지 않는 시·군 단위 및 시설 유형(본사/공장) 조건을 premises에 보존했다.",
    },
    profiles: [
      { region: { code: "48", label: "경남" } },
      {
        region: { code: "48", label: "경남" },
        other_conditions: { headquarters_city: "김해시", observed_at: "공고일 이후" },
      },
      {},
    ],
    expectedEligibility: ["conditional", "conditional", "conditional"],
  },
  {
    id: "future-relocation-intent-is-not-current-region",
    provenance: {
      artifactPath: "spike-out/analysis-lab/kstartup__178930/run-2026-09-01T090004.457Z-815dbc.json",
      artifactSha256: "be787e007465456d54f53495fa9fdfecb3f08979ae550753a518d205ebd4c6ff",
      inputSha256: "cf01b2f35cd65a467b720fae573cafd0363920359c59029e95b7a047f56dcba2",
      grantId: "c5455c07-6501-44ec-89bc-4bf8fd290e65",
      runId: "run-2026-09-01T090004.457Z-815dbc",
      source: "kstartup",
      sourceId: "178930",
      criterionIndex: 4,
    },
    sourceExcerptSha256: "9d6a3235735b15c478e9ec4d5a533806c49a225802e6c90ab21683eaa14cd00c",
    criterion: {
      dimension: "premises",
      kind: "required",
      operator: "text_only",
      value: {
        note: "가상오피스 지원 계약 체결 후 1개월 이내에 광명업사이클아트센터로 사업자 주소지 등록(변경)이 가능해야 함. 신청 시점의 소재지 제한은 명시되지 않으며(지원지역: 전국), 계약 후 주소지 이전(등록·변경) 가능성이 조건이다.",
      },
      confidence: 0.9,
      sourceSpan: "○ 가상오피스 지원 계약 체결 후 1개월 이내에 광명업사이클아트센터로 사업자 주소지 등록(변경) 가능한 (예비)창업자",
      spanVerified: true,
      note: null,
    },
    profiles: [
      { region: { code: "41", label: "경기" } },
      { region: { code: "11", label: "서울" } },
      {},
    ],
    expectedEligibility: ["conditional", "conditional", "conditional"],
  },
  {
    id: "export-amount-is-not-company-revenue",
    provenance: {
      artifactPath: "spike-out/analysis-lab/bizinfo__PBLN_000000000120246/run-2026-09-01T031350.789Z-6172c8.json",
      artifactSha256: "2e957136cb1f6ee079dcf3c8bc8900ec1cce4d41f9d8cb14df5b5dc275dab249",
      inputSha256: "d452cc4e97343dc97cfb266b05919abeb93a4007996fd773051b54ecadd2143a",
      grantId: "ccefe95c-2166-4aa0-b21e-d48113fae147",
      runId: "run-2026-09-01T031350.789Z-6172c8",
      source: "bizinfo",
      sourceId: "PBLN_000000000120246",
      criterionIndex: 1,
    },
    sourceExcerptSha256: "4b58dc834fa1f117926a6ad5016ea9f769ddbc23818b8d0ead45ea22e28a166c",
    criterion: {
      dimension: "export_performance",
      kind: "required",
      operator: "text_only",
      value: {
        note: "전년도 연간 총 수출액이 5천만불(USD 50,000,000) 미만이어야 함(상한 요건). 산정 기준·증빙은 원문 미기재.",
      },
      confidence: 0.92,
      sourceSpan: "전년도 연간 총 수출액이 5천만불 미만인 중소ㆍ중견기업",
      spanVerified: true,
      note: "수출실적 하한이 아니라 상한 조건이며, 기준연도·통화·집계범위가 결합되어 있어 canonical 수치화 대신 text_only로 보존.",
    },
    profiles: [
      { revenue_krw: 1_000_000 },
      { revenue_krw: 100_000_000_000 },
      {},
    ],
    expectedEligibility: ["conditional", "conditional", "conditional"],
  },
  {
    id: "unknown-preferred-export-evidence-does-not-block-eligibility",
    provenance: {
      artifactPath: "spike-out/analysis-lab/kstartup__178984/run-2026-08-31T221918.083Z-02bd27.json",
      artifactSha256: "d496a48c6964f8104c4d09c57899b95ed50ac71b5690d03ec85e9134df3f6ab1",
      inputSha256: "5a88602bcd76aa59abf84a5c300fa1e5edb244cb28ca562eaef47b24f9791217",
      grantId: "1d4b5ab8-7671-4911-9d36-545dfa7c6e14",
      runId: "run-2026-08-31T221918.083Z-02bd27",
      source: "kstartup",
      sourceId: "178984",
      criterionIndex: 4,
    },
    sourceExcerptSha256: "41d81abaecb11bdef986f78c730a84233a341ff5884f2f4092509381b8eab790",
    criterion: {
      dimension: "export_performance",
      kind: "preferred",
      operator: "text_only",
      value: {
        note: "수출성장성 평가표에서 금번 전시회 개최국(인도네시아) 대상 최근 2개년 수출실적(USD), 샘플실적(USD), MOU 실적을 작성·평가한다. 제출서류에 '(해당시) 수출실적증명서 1부'가 포함된다.",
      },
      confidence: 0.75,
      sourceSpan: "※ 금번 전시회(상담회) 개최국 대상 최근 2개년 실적 작성",
      spanVerified: true,
      note: "구체적 배점은 원문에 없으며 평가표는 '예시'로 표기되어 있다.",
    },
    profiles: [{}, { revenue_krw: 0 }, { revenue_krw: 100_000_000_000 }],
    expectedEligibility: ["eligible", "eligible", "eligible"],
  },
];

let verifiedSourceArtifactCount = 0;
for (const item of cases) {
  assert.equal(
    sha256(stableJson({ provenance: item.provenance, criterion: item.criterion })),
    item.sourceExcerptSha256,
    `${item.id}: 최소 source excerpt SHA`,
  );

  const sourceArtifactVerified = await verifySourceArtifactIfAvailable(item);
  if (sourceArtifactVerified) verifiedSourceArtifactCount += 1;

  const conversion = convertSelectedLabCriteria({
    runId: item.provenance.runId,
    grantId: item.provenance.grantId,
    sourceId: item.provenance.sourceId,
    criteria: [item.criterion],
  }, {
    selections: [{ criterionIndex: 0, needsReview: false }],
  });
  assert.equal(conversion.report.error, null, `${item.id}: projection error`);
  assert.equal(conversion.criteria.length, 1, `${item.id}: projection criterion count`);
  assert.equal(conversion.report.items?.[0]?.status, "downgraded", `${item.id}: downgrade status`);
  assert.equal(conversion.report.items?.[0]?.reason, "reserved_dimension", `${item.id}: downgrade reason`);

  const projected = conversion.criteria[0]!;
  assert.equal(projected.dimension, "other", `${item.id}: reserved axis must not activate`);
  assert.equal(projected.operator, "text_only", `${item.id}: text-only guardrail`);
  assert.equal(projected.kind, item.criterion.kind, `${item.id}: kind preservation`);
  assert.equal(projected.source_span, item.criterion.sourceSpan, `${item.id}: source span preservation`);
  assert.deepEqual(projected.value, {
    note: (item.criterion.value as { note: string }).note,
    downgrade_reason: "reserved_dimension",
    original_dimension: item.criterion.dimension,
    original_operator: item.criterion.operator,
    original_value: item.criterion.value,
  }, `${item.id}: original dimension/operator/value preservation`);

  const results = item.profiles.map((profile) => matchGrantCriteria([projected], profile));
  assert.deepEqual(
    results.map((result) => result.eligibility),
    item.expectedEligibility,
    `${item.id}: matcher eligibility`,
  );
  for (const result of results) {
    assert.equal(result.rule_trace[0]?.kind, item.criterion.kind, `${item.id}: trace kind`);
    assert.equal(result.rule_trace[0]?.result, "unknown", `${item.id}: unresolved trace`);
  }
}

const defensiveExclusion = convertSelectedLabCriteria({
  runId: "run-synthetic-reserved-exclusion",
  grantId: "grant-synthetic-reserved-exclusion",
  sourceId: "synthetic-reserved-exclusion",
  criteria: [{
    dimension: "premises",
    kind: "exclusion",
    operator: "text_only",
    value: { note: "특정 시설에 입주 중인 기업은 제외" },
    confidence: 0.9,
    sourceSpan: "특정 시설에 입주 중인 기업은 제외",
    spanVerified: true,
    note: "원 36건에는 exclusion이 없어 방어 계약만 합성한다.",
  }],
}, {
  selections: [{ criterionIndex: 0, needsReview: false }],
});
assert.equal(
  matchGrantCriteria(defensiveExclusion.criteria, {}).eligibility,
  "conditional",
  "미확정 reserved exclusion은 자동 통과하지 않는다",
);
assert.equal(defensiveExclusion.criteria[0]?.kind, "exclusion");

if (process.env.CUNOTE_REQUIRE_SOURCE_ARTIFACTS === "1") {
  assert.equal(
    verifiedSourceArtifactCount,
    cases.length,
    "CUNOTE_REQUIRE_SOURCE_ARTIFACTS=1이면 모든 원 artifact가 필요합니다.",
  );
}

console.log(JSON.stringify({
  ok: true,
  sourceBoundCases: cases.length,
  sourceArtifactsVerified: verifiedSourceArtifactCount,
  requiredCases: cases.filter((item) => item.criterion.kind === "required").length,
  preferredCases: cases.filter((item) => item.criterion.kind === "preferred").length,
  syntheticExclusionCases: 1,
  reservedAxesActivated: 0,
  modelCalls: 0,
  serviceWrites: 0,
  limitation: "immutable LabRun artifact binding and projection semantics only; not an independent official-source correctness review",
}, null, 2));

async function verifySourceArtifactIfAvailable(
  item: ReservedDimensionSourceCase,
): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(item.provenance.artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  assert.equal(sha256(bytes), item.provenance.artifactSha256, `${item.id}: raw artifact SHA`);
  const run = JSON.parse(bytes.toString("utf8")) as {
    grantId?: unknown;
    runId?: unknown;
    source?: unknown;
    sourceId?: unknown;
    inputSha256?: unknown;
    criteria?: unknown[];
  };
  assert.equal(run.grantId, item.provenance.grantId, `${item.id}: artifact grantId`);
  assert.equal(run.runId, item.provenance.runId, `${item.id}: artifact runId`);
  assert.equal(run.source, item.provenance.source, `${item.id}: artifact source`);
  assert.equal(run.sourceId, item.provenance.sourceId, `${item.id}: artifact sourceId`);
  assert.equal(run.inputSha256, item.provenance.inputSha256, `${item.id}: artifact input SHA`);
  assert.deepEqual(
    minimalCriterion(run.criteria?.[item.provenance.criterionIndex]),
    item.criterion,
    `${item.id}: artifact criterion excerpt`,
  );
  return true;
}

function minimalCriterion(value: unknown): LabCriterion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const criterion = value as LabCriterion;
  return {
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
    confidence: criterion.confidence,
    sourceSpan: criterion.sourceSpan,
    spanVerified: criterion.spanVerified,
    note: criterion.note,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

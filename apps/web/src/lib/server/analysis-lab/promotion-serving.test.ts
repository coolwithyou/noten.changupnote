import assert from "node:assert/strict";
import type { GrantPromotionPlan } from "./promote";
import {
  createPromotionReleaseManifest,
  planSha256,
  sha256Canonical,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleasePlanItem,
} from "./promotion-release";
import {
  authoringReadinessForPromotionPlan,
  buildPromotionServingRequestSnapshot,
  resolvePromotionServingEvidence,
  type PromotionServingLedgerItem,
} from "./promotion-serving";
import { assertServingVerificationTargets } from "../deep-analysis/verify-serving-cli";

const grantId = "00000000-0000-4000-8000-000000000001";
const runId = "run-2026-08-06T000000.000Z-abcd";
const plan: GrantPromotionPlan = {
  grantId,
  runId,
  title: "검증된 로컬 구독 공고",
  origin: "audited",
  auditState: "ai_audit_concur",
  criteria: [],
  criterionIndexByPosition: [],
  criterionStableKeys: [],
  resolutions: [],
  conversion: {
    grantId,
    runId,
    verdicts: { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 },
    missedConditions: 0,
    inputRows: 0,
    converted: 0,
    downgraded: 0,
    dropped: 0,
    error: null,
  },
  questions: [],
  droppedQuestionCandidates: 0,
};
const planItem: PromotionReleasePlanItem = {
  grantId,
  planSha256: planSha256(plan),
  promotionPlan: plan,
  beforeCriteriaSha256: "1".repeat(64),
  beforeQuestionsSha256: "2".repeat(64),
  dedupComponentSha256: "3".repeat(64),
  criteriaCountBefore: 0,
  criteriaCountAfter: 0,
  questionCountAfter: 0,
  pendingCount: 0,
  downgradedCount: 0,
  costUsd: 0,
};

assert.deepEqual(
  authoringReadinessForPromotionPlan({}),
  { status: "unverified", sourceDisposition: "unverified" },
  "split readiness가 없는 역사 release는 자동 작성 ready로 추정하지 않는다",
);
assert.deepEqual(
  authoringReadinessForPromotionPlan({
    analysisLaunchReadiness: {
      disposition: "ready",
      reasons: [],
    } as unknown as NonNullable<PromotionReleasePlanItem["analysisLaunchReadiness"]>,
  }),
  { status: "unverified", sourceDisposition: "unverified" },
  "split 필드 추가 전 analysis-launch release도 예외 없이 unverified로 소비한다",
);

for (const [status, sourceDisposition] of [
  ["ready", "ready"],
  ["held", "held"],
  ["held", "not_applicable"],
  ["held", "unverified"],
] as const) {
  assert.deepEqual(authoringReadinessForPromotionPlan({
    analysisLaunchReadiness: {
      runFeatureReadiness: {
        authoring: { status, sourceDisposition, reasons: status === "ready" ? [] : ["held"] },
      },
      authoringEvidenceStatus: status === "ready" ? "verified" : "held",
      authoringEvidenceReasons: status === "ready" ? [] : ["held"],
    } as unknown as NonNullable<PromotionReleasePlanItem["analysisLaunchReadiness"]>,
  }), { status, sourceDisposition });
}
assert.deepEqual(authoringReadinessForPromotionPlan({
  analysisLaunchReadiness: {
    runFeatureReadiness: {
      authoring: { status: "ready", sourceDisposition: "ready", reasons: [] },
    },
    authoringEvidenceStatus: "held",
    authoringEvidenceReasons: ["application_field_analysis_binding"],
  } as unknown as NonNullable<PromotionReleasePlanItem["analysisLaunchReadiness"]>,
}), { status: "held", sourceDisposition: "ready" }, "current 작성 evidence가 held이면 run ready만으로 자동 작성을 열지 않는다");
assert.deepEqual(authoringReadinessForPromotionPlan({
  analysisLaunchReadiness: {
    runFeatureReadiness: {
      authoring: { status: "ready", sourceDisposition: "ready", reasons: [] },
    },
    authoringEvidenceStatus: "verified",
    authoringEvidenceReasons: undefined,
  } as unknown as NonNullable<PromotionReleasePlanItem["analysisLaunchReadiness"]>,
}), { status: "held", sourceDisposition: "ready" }, "evidence reason 계약이 누락된 객체도 자동 작성을 열지 않는다");

function localManifest() {
  return createPromotionReleaseManifest({
    releaseId: "deep-local-canary-r1",
    revision: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    gitCommit: "4".repeat(40),
    buildDigest: "5".repeat(40),
    cohortLabel: "local-canary",
    canaryGrantIds: [grantId],
    sourceArtifacts: [{
      grantId,
      runId,
      runSha256: "6".repeat(64),
      aiReviewSha256: "7".repeat(64),
      auditSha256: "8".repeat(64),
      overlaySha256: null,
      confirmationsSha256: null,
      localLabEvidence: {
        schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
        transport: "claude-cli",
        model: "claude-opus-5",
        promptVersion: "lab-deep-v7",
        inputSha256: "9".repeat(64),
        reviewMethod: "ai_audit",
        reviewModel: "claude-fable-5",
        reviewPromptVersion: "ai-review-v3",
        reviewTransport: "claude-cli",
        auditModel: "claude-sonnet-5",
        auditPromptVersion: "ai-audit-v2",
        auditTransport: "claude-cli",
      },
    }],
    plans: [planItem],
  });
}

function ledger(overrides: Partial<PromotionServingLedgerItem> = {}): PromotionServingLedgerItem {
  const manifest = localManifest();
  return {
    grantId,
    runId,
    planSha256: planItem.planSha256,
    deepAnalysisRunId: null,
    releaseManifestSha256: manifest.manifestSha256,
    manifest,
    ...overrides,
  };
}

{
  const manifest = localManifest();
  const releaseDbId = "00000000-0000-4000-8000-000000000010";
  const item = {
    releaseDbId,
    grantId,
    runId,
    planSha256: planItem.planSha256,
    deepAnalysisRunId: null,
    releaseManifestSha256: manifest.manifestSha256,
  };
  const snapshot = buildPromotionServingRequestSnapshot({
    items: [
      item,
      { ...item, planSha256: "a".repeat(64) },
      {
        ...item,
        releaseDbId: "00000000-0000-4000-8000-000000000011",
        deepAnalysisRunId: "00000000-0000-4000-8000-000000000012",
      },
    ],
    releases: [{
      releaseDbId,
      releaseManifestSha256: manifest.manifestSha256,
      manifest,
    }],
  });
  assert.equal(snapshot.items.length, 2, "local item binding 불일치는 release 검증 재사용과 무관하게 계속 거부한다");
  assert.deepEqual(snapshot.items.map(({ evidence }) => evidence.kind), [
    "verified_local_lab",
    "production_deep_run",
  ]);
  assert.deepEqual(snapshot.metrics, {
    itemBindingRows: 3,
    releaseDocumentRows: 1,
    releaseManifestBytes: Buffer.byteLength(JSON.stringify(manifest)),
    releaseManifestValidations: 1,
  }, "manifest 전송·검증 계측은 item 수가 아니라 고유 local release 문서 수를 따른다");

  assert.equal(buildPromotionServingRequestSnapshot({
    items: [item],
    releases: [{
      releaseDbId,
      releaseManifestSha256: "f".repeat(64),
      manifest,
    }],
  }).items.length, 0, "DB release hash와 manifest가 다르면 전체 local item을 거부한다");

  assert.equal(buildPromotionServingRequestSnapshot({
    items: [item],
    releases: [
      { releaseDbId, releaseManifestSha256: manifest.manifestSha256, manifest },
      { releaseDbId, releaseManifestSha256: manifest.manifestSha256, manifest },
    ],
  }).items.length, 0, "동일 release 문서가 중복되면 임의 선택하지 않는다");
}

{
  const resolved = resolvePromotionServingEvidence(ledger());
  assert.equal(resolved?.kind, "verified_local_lab");
  assert.equal(
    resolved?.kind === "verified_local_lab" ? resolved.evidence.promptVersion : null,
    "lab-deep-v7",
  );
  assert.deepEqual(resolved?.authoringReadiness, {
    status: "unverified",
    sourceDisposition: "unverified",
  }, "feature projection 전 release는 작성 ready로 추정하지 않는다");
}

assert.doesNotThrow(
  () => assertServingVerificationTargets([{ ...ledger(), status: "applied" }]),
  "verified local lab item은 deepAnalysisRunId 없이도 serving 검증 대상이어야 한다",
);
assert.throws(
  () => assertServingVerificationTargets([{ ...ledger(), status: "prepared" }]),
  /applied promotion item/,
  "미적용 local item은 serving 검증 대상이 아니어야 한다",
);

assert.equal(
  resolvePromotionServingEvidence(ledger({ deepAnalysisRunId: "00000000-0000-4000-8000-000000000099" }))?.kind,
  "production_deep_run",
  "운영 deep run FK는 기존 서빙 경로를 유지해야 한다",
);
assert.deepEqual(
  resolvePromotionServingEvidence(ledger({
    deepAnalysisRunId: "00000000-0000-4000-8000-000000000099",
  }))?.authoringReadiness,
  { status: "unverified", sourceDisposition: "unverified" },
  "기존 production deep run도 작성 필드 근거 없이 ready로 추정하지 않는다",
);

assert.equal(
  resolvePromotionServingEvidence(ledger({ planSha256: "a".repeat(64) })),
  null,
  "release item과 manifest plan이 다르면 로컬 승격을 거부해야 한다",
);

assert.equal(
  resolvePromotionServingEvidence(ledger({ releaseManifestSha256: "b".repeat(64) })),
  null,
  "DB release hash와 manifest hash가 다르면 로컬 승격을 거부해야 한다",
);

{
  const legacy = localManifest();
  delete legacy.servingProvenance;
  const { manifestSha256: _old, ...body } = legacy;
  const legacyWithoutRehash = { ...body, manifestSha256: sha256Canonical(body) };
  assert.equal(
    resolvePromotionServingEvidence(ledger({ manifest: legacyWithoutRehash })),
    null,
    "serving provenance가 없는 기존 local release는 계속 제외해야 한다",
  );
}

{
  const tampered = localManifest();
  tampered.sourceArtifacts[0]!.localLabEvidence!.transport = "api" as "claude-cli";
  assert.equal(
    resolvePromotionServingEvidence(ledger({ manifest: tampered })),
    null,
    "API 또는 변조된 local evidence는 서빙 provenance가 될 수 없다",
  );
}


console.log("promotion serving provenance tests: ok");

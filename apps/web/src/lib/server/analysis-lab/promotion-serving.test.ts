import assert from "node:assert/strict";
import type { GrantPromotionPlan } from "./promote";
import {
  selectPromotionCandidatesForRelease,
  verifyPromotionSourceArtifact,
  type PromotionCandidate,
} from "./promotion-candidates";
import {
  createPromotionReleaseManifest,
  planSha256,
  sha256Canonical,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleasePlanItem,
} from "./promotion-release";
import {
  resolvePromotionServingEvidence,
  type PromotionServingLedgerItem,
} from "./promotion-serving";

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
  const resolved = resolvePromotionServingEvidence(ledger());
  assert.equal(resolved?.kind, "verified_local_lab");
  assert.equal(
    resolved?.kind === "verified_local_lab" ? resolved.evidence.promptVersion : null,
    "lab-deep-v7",
  );
}

assert.equal(
  resolvePromotionServingEvidence(ledger({ deepAnalysisRunId: "00000000-0000-4000-8000-000000000099" }))?.kind,
  "production_deep_run",
  "운영 deep run FK는 기존 서빙 경로를 유지해야 한다",
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

{
  const manifest = localManifest();
  const candidate = {
    plan,
    sourceArtifact: manifest.sourceArtifacts[0]!,
    source: {
      origin: "audited",
      auditEvidence: {
        reviewModel: "claude-fable-5",
        reviewPromptVersion: "ai-review-v3",
        reviewTransport: "claude-cli",
        auditModel: "claude-sonnet-5",
        auditPromptVersion: "ai-audit-v2",
        auditTransport: "claude-cli",
      },
      run: {
        runId,
        grantId,
        source: "kstartup",
        sourceId: "test-source",
        title: plan.title,
        model: "claude-opus-5",
        transport: "claude-cli",
        promptVersion: "lab-deep-v7",
        startedAt: "2026-08-06T00:00:00.000Z",
        durationMs: 1,
        inputBlocks: [],
        inputTotalChars: 100,
        inputSha256: "9".repeat(64),
        usage: null,
        costUsd: 0,
        analysisMarkdown: "분석",
        programIntent: null,
        criteria: [],
        axisAssessments: [],
        taxonomyProposals: [],
        dimensionDiffs: [],
        error: null,
      },
    },
  } satisfies PromotionCandidate;
  assert.deepEqual(
    selectPromotionCandidatesForRelease([candidate], {
      grantId,
      auditedLocalCanary: true,
    }),
    [candidate],
  );
  assert.throws(
    () => selectPromotionCandidatesForRelease([candidate], { grantId }),
    /audited-local-canary/,
    "주간 사람검수 게이트 생략은 명시적인 단일 canary에서만 허용해야 한다",
  );
  const heldCandidate: PromotionCandidate = {
    ...candidate,
    source: {
      ...candidate.source,
      run: {
        ...candidate.source.run,
        primaryValidationOutcome: "held",
        error: null,
      },
    },
  };
  assert.throws(
    () => selectPromotionCandidatesForRelease([heldCandidate], {
      grantId,
      auditedLocalCanary: true,
    }),
    /봉인된 구독 분석/,
    "held 런은 error:null이어도 audited local canary로 우회할 수 없다",
  );
  assert.deepEqual(
    await verifyPromotionSourceArtifact(heldCandidate.sourceArtifact, {
      readRunImpl: async () => heldCandidate.source.run,
    }),
    { ok: false, changed: ["run_outcome"] },
    "실제 source artifact 재검증도 held를 fail-closed로 차단한다",
  );
}

console.log("promotion serving provenance tests: ok");

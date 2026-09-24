import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { publishKStartupGrants } from "../ingestion/kstartupPublisher";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import { saveLabRun } from "../analysis-lab/run-store";
import { applyApprovedPromotionCanary } from "../analysis-lab/promote-cli";
import {
  manualConfirmationEvaluationsFilePath,
  saveManualConfirmationEvaluations,
} from "../analysis-lab/manual-confirmation-evaluations";
import {
  createPromotionReleaseManifest, hashFile, planSha256,
  promotionReleaseArtifactPath, writeImmutablePromotionArtifact,
} from "../analysis-lab/promotion-release";
import {
  loadPromotionGrantSnapshot, promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
} from "../analysis-lab/promotion-snapshot";
import { listGrantConfirmations } from "../matches/grantConfirmations";
import { buildSyntheticReviewedCompanyFact } from "./questionPreparationAdapterPostgres.integration";
import { createQuestionPreparationFormalFixture } from "./questionPreparationFormalFixture";
import {
  executeApprovedGrantSupply, loadCurrentGrantSupplySnapshot,
  loadStoredGrantSupplyAssets, planGrantSupply,
} from "./grantSupply";

/** 발행 전 새 공고→로컬 자산→승인 분석 발행→질문 serving을 전용 socket DB에서 검증한다. */
export async function verifyNewGrantFormalSupplyPostgres(input: {
  admin: postgres.Sql;
  socket: string;
  companyId: string;
}) {
  assert.equal(process.env.CUNOTE_PRODUCT_TEST_SOCKET, input.socket);
  const db = drizzle(input.admin, { schema });
  const sourceId = `new-formal-supply-${crypto.randomUUID()}`;
  const asOf = new Date("2026-09-24T03:00:00.000Z");
  const entry: NormalizedGrant<KStartupAnnouncement> = {
    raw: {
      source: "kstartup", source_id: sourceId,
      payload: { pbanc_sn: sourceId, intg_pbanc_biz_nm: "신규 자산 공급 격리 공고" },
      attachments: [{ filename: "guide.pdf", url: "https://example.invalid/new-guide.pdf" }],
      status: "published",
    },
    grant: {
      source: "kstartup", source_id: sourceId, title: "신규 자산 공급 격리 공고",
      apply_start: "2026-09-01T00:00:00.000Z", apply_end: "2026-10-01T00:00:00.000Z",
      status: "open", f_regions: [], f_industries: [], f_sizes: [],
      f_founder_traits: [], f_required_certs: [], f_apply_methods: [],
      f_authoring_mode: "unknown", overall_confidence: 1, parser_version: "fixture-v1",
    }, criteria: [],
  };
  const publication = await publishKStartupGrants(db, [entry], { collectedAt: asOf });
  assert.equal(publication.revisionCounts.new, 1);
  const [published] = await input.admin<{ id: string }[]>`select id from grants
    where source='kstartup' and source_id=${sourceId}`;
  assert.ok(published);
  const grantId = published.id;
  assert.equal(publication.supplyWorkItems?.[0]?.grantId, grantId);
  const source = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(source);
  const runId = `run-2026-09-24T030000.000Z-${grantId.replaceAll("-", "").slice(0, 6)}`;
  const reviewed = buildSyntheticReviewedCompanyFact({
    grantId, sourceId, runId, sourceRevisionSha256: source.sourceRevisionSha256,
  });
  const formal = await createQuestionPreparationFormalFixture({
    run: reviewed.run, review: reviewed.review,
    selectedManual: {
      artifact: reviewed.artifact, selection: reviewed.selection,
      path: "/tmp/synthetic-new-formal-review.json", legacyShaOnly: false,
    },
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: source.sourceRawSha256,
  });
  const originalCwd = process.cwd();
  try {
    await writeFile(`${formal.root}/pnpm-workspace.yaml`, "packages: []\n", { flag: "wx" });
    process.chdir(formal.root);
    const before = await loadCurrentGrantSupplySnapshot({ db, grantId, asOf });
    assert.ok(before);
    assert.equal(before.readinessInput.analysis.status, "missing");
    assert.equal(before.nextWork.action, "condition_analysis");
    const emptyAssets = await loadStoredGrantSupplyAssets({
      grantId, source: "kstartup", sourceId,
      sourceRevisionSha256: source.sourceRevisionSha256,
      loadCurrentEvidence: formal.dependencies.loadCurrentGrantEvidence!,
    });
    assert.equal(planGrantSupply({ snapshot: before, inventory: emptyAssets }).stage,
      "await_approved_model_run");
    const runFile = await saveLabRun(reviewed.run);
    assert.ok(runFile.endsWith(`${runId}.json`));
    const manualFile = manualConfirmationEvaluationsFilePath("kstartup", sourceId, runId);
    await mkdir(dirname(manualFile), { recursive: true });
    await saveManualConfirmationEvaluations(reviewed.artifact, reviewed.run, manualFile);
    const assets = await loadStoredGrantSupplyAssets({
      grantId, source: "kstartup", sourceId,
      sourceRevisionSha256: source.sourceRevisionSha256,
      manualSelection: {
        grantId, runId, revision: reviewed.selection.revision,
        artifactSha256: reviewed.selection.artifactSha256,
      },
      loadCurrentEvidence: formal.dependencies.loadCurrentGrantEvidence!,
    });
    assert.equal(assets.status, "checked");
    const plan = planGrantSupply({ snapshot: before, inventory: assets });
    assert.equal(plan.stage, "review_existing_analysis");
    assert.equal(plan.assetBinding?.currentBinding, "verified");
    assert.equal(plan.assetBinding?.manualStatus, "active");
    assert.equal(plan.assetBinding?.runSha256, formal.candidate.sourceArtifact.runSha256);

    const beforePromotion = await loadPromotionGrantSnapshot(db, grantId);
    const beforeHashes = promotionGrantSnapshotHashes(beforePromotion);
    const candidate = formal.candidate;
    const releaseId = `new-formal-supply-release-${grantId}`;
    const releaseManifest = createPromotionReleaseManifest({
      releaseId, revision: 1, createdAt: "2026-09-24T03:01:00.000Z",
      gitCommit: "7".repeat(40), buildDigest: "8".repeat(40),
      cohortLabel: "new-formal-supply-postgres", canaryGrantIds: [grantId],
      sourceArtifacts: [candidate.sourceArtifact],
      plans: [{
        grantId, planSha256: planSha256(candidate.plan), promotionPlan: candidate.plan,
        analysisLaunchReadiness: candidate.readiness,
        beforeCriteriaSha256: beforeHashes.criteriaSha256,
        beforeQuestionsSha256: beforeHashes.questionsSha256,
        dedupComponentSha256: beforeHashes.dedupComponentSha256,
        criteriaCountBefore: 0, criteriaCountAfter: candidate.plan.criteria.length,
        questionCountAfter: candidate.plan.questions.length,
        pendingCount: 0, downgradedCount: candidate.plan.conversion.downgraded,
        transport: "claude-cli", costUsd: null,
      }],
    });
    assert.equal(candidate.plan.questions.length, 1);
    assert.equal(candidate.plan.questions[0]?.conditionKey, reviewed.conditionKey);
    await writeImmutablePromotionArtifact(
      promotionReleaseArtifactPath(releaseId, "manifest.json"), releaseManifest);
    const gateSummary = {
      aggregateSha256: "a".repeat(64), shadowSha256: "b".repeat(64),
      dryRunSha256: "c".repeat(64),
    };
    const approvalFile = promotionReleaseArtifactPath(releaseId, "approval.json");
    await writeImmutablePromotionArtifact(approvalFile, {
      schema: "analysis-lab-promotion-approval-v1", releaseId,
      manifestSha256: releaseManifest.manifestSha256,
      releasePlanSha256: releaseManifest.releasePlanSha256,
      approvedBy: "synthetic-review-approver", approvedAt: "2026-09-24T03:02:00.000Z",
      ...gateSummary,
    });
    const releaseDbId = crypto.randomUUID();
    const releaseItemId = crypto.randomUUID();
    await input.admin`insert into analysis_lab_promotion_releases
      (id,release_id,revision,manifest_sha256,release_plan_sha256,manifest,git_commit,build_digest,
       status,gate_summary,created_by,approved_by,approved_at,approval_artifact_sha256)
      values (${releaseDbId},${releaseId},1,${releaseManifest.manifestSha256},
        ${releaseManifest.releasePlanSha256},${JSON.stringify(releaseManifest)}::jsonb,
        ${releaseManifest.gitCommit},${releaseManifest.buildDigest},'approved',
        ${JSON.stringify(gateSummary)}::jsonb,'synthetic-release-preparer',
        'synthetic-review-approver','2026-09-24T03:02:00.000Z',${await hashFile(approvalFile)})`;
    await input.admin`insert into analysis_lab_promotion_items
      (id,release_db_id,grant_id,run_id,plan_sha256,before_snapshot,before_sha256,status)
      values (${releaseItemId},${releaseDbId},${grantId},${runId},${planSha256(candidate.plan)},
        ${JSON.stringify(beforePromotion)}::jsonb,
        ${promotionGrantSnapshotStateSha256(beforePromotion)},'prepared')`;
    assert.equal((await input.admin`select supply_plan_evidence_sha256
      from analysis_lab_promotion_items where id=${releaseItemId}`)[0]?.supply_plan_evidence_sha256,
      null);
    const applied = await executeApprovedGrantSupply({
      db, grantId, expectedEvidenceSha256: plan.evidenceSha256,
      approvedRelease: {
        releaseId, manifestSha256: releaseManifest.manifestSha256,
        executedBy: "synthetic-release-executor",
      }, asOf,
      manualConfirmationSelection: {
        grantId, runId, revision: reviewed.selection.revision,
        artifactSha256: reviewed.selection.artifactSha256,
      },
      isolatedAnalysisLaunch: formal.dependencies,
    });
    assert.equal(applied.status, "completed");
    assert.equal(applied.modelCalls, 0);
    assert.equal(applied.externalWrites, 1);
    const after = await loadCurrentGrantSupplySnapshot({ db, grantId, asOf });
    assert.equal(after?.readiness.category, "A");
    const serving = await listGrantConfirmations({ companyId: input.companyId, grantId }, db as CunoteDb);
    assert.equal(serving.questions.length, 1);
    assert.equal((await input.admin`select condition_key from grant_confirmation_questions
      where grant_id=${grantId} and invalidated_at is null`)[0]?.condition_key, reviewed.conditionKey);
    assert.equal((await input.admin`select status from analysis_lab_promotion_items
      where id=${releaseItemId}`)[0]?.status, "applied");
    const [appliedItem] = await input.admin<{
      supply_plan_evidence_sha256: string | null;
      after_sha256: string | null;
      applied_at: Date | null;
    }[]>`select supply_plan_evidence_sha256,after_sha256,applied_at
      from analysis_lab_promotion_items where id=${releaseItemId}`;
    assert.equal(appliedItem?.supply_plan_evidence_sha256, plan.evidenceSha256);
    assert.ok(appliedItem?.after_sha256);
    const execution = {
      db, grantId, approvedRelease: {
        releaseId, manifestSha256: releaseManifest.manifestSha256,
        executedBy: "synthetic-release-executor",
      }, asOf,
      manualConfirmationSelection: {
        grantId, runId, revision: reviewed.selection.revision,
        artifactSha256: reviewed.selection.artifactSha256,
      },
      isolatedAnalysisLaunch: formal.dependencies,
    };
    const resumed = await executeApprovedGrantSupply({
      ...execution, expectedEvidenceSha256: plan.evidenceSha256,
    });
    assert.equal(resumed.status, "already_complete");
    assert.equal(resumed.externalWrites, 0);
    assert.equal(resumed.modelCalls, 0);
    const [replayedItem] = await input.admin<{
      after_sha256: string | null;
      applied_at: Date | null;
    }[]>`select after_sha256,applied_at from analysis_lab_promotion_items where id=${releaseItemId}`;
    assert.equal(replayedItem?.after_sha256, appliedItem?.after_sha256);
    assert.equal(String(replayedItem?.applied_at), String(appliedItem?.applied_at));
    await assert.rejects(() => executeApprovedGrantSupply({
      ...execution, expectedEvidenceSha256: "0".repeat(64),
    }), /grant_supply_promotion_recovery_before_evidence_mismatch/u);
    assert.equal((await input.admin`select supply_plan_evidence_sha256
      from analysis_lab_promotion_items where id=${releaseItemId}`)[0]?.supply_plan_evidence_sha256,
      plan.evidenceSha256);
    await input.admin`update analysis_lab_promotion_releases set status='rolled_back'
      where id=${releaseDbId}`;
    await assert.rejects(() => executeApprovedGrantSupply({
      ...execution, expectedEvidenceSha256: plan.evidenceSha256,
    }), /grant_supply_plan_drift/u);
    await assert.rejects(() => applyApprovedPromotionCanary({
      db, releaseId, grantId,
      expectedManifestSha256: releaseManifest.manifestSha256,
      actor: "synthetic-release-executor",
      supplyPlanEvidenceSha256: plan.evidenceSha256,
      isolatedAnalysisLaunch: formal.dependencies,
    }), /적용된 release의 현행 상태 또는 승인 결속/u);
    await input.admin`update analysis_lab_promotion_releases set status='canary_passed'
      where id=${releaseDbId}`;
    await input.admin`update grant_confirmation_questions set prompt='격리 serving drift'
      where grant_id=${grantId} and invalidated_at is null`;
    await assert.rejects(() => executeApprovedGrantSupply({
      ...execution, expectedEvidenceSha256: plan.evidenceSha256,
    }), /현재 source\/baseline\/guard|after_drift|grant_supply_plan_drift/u);
    assert.equal((await input.admin`select status from analysis_lab_promotion_items
      where id=${releaseItemId}`)[0]?.status, "applied");
    console.log("PASS: publisher new grant → local formal asset inventory → exact approved release file → DB writer → A/question serving");
  } finally {
    process.chdir(originalCwd);
    await rm(formal.root, { recursive: true, force: true });
  }
}

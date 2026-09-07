import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "../../apps/web/node_modules/drizzle-orm/postgres-js/index.js";
import * as schema from "../../apps/web/src/lib/server/db/schema";
import { acquireGrantPublicationLock } from "../../apps/web/src/lib/server/ingestion/grantPublicationLock";
import { loadDeepAnalysisSourceBinding } from "../../apps/web/src/lib/server/deep-analysis/prepareInput";
import {
  buildManualConfirmationEvaluationsArtifact,
  buildManualConfirmationEvaluationsRevisionArtifact,
  manualConfirmationEvaluationSelectionForArtifact,
  type ManualConfirmationEvaluationsArtifact,
  type SelectedManualConfirmationEvaluations,
} from "../../apps/web/src/lib/server/analysis-lab/manual-confirmation-evaluations";
import type { LabConfirmationsFile } from "../../apps/web/src/lib/server/analysis-lab/confirmations";
import type { LabCriterion, LabReview, LabRun } from "../../apps/web/src/lib/server/analysis-lab/lab-contract";
import { planGrantPromotion, type GrantPromotionPlan } from "../../apps/web/src/lib/server/analysis-lab/promote";
import { createDrizzlePromotionPort } from "../../apps/web/src/lib/server/analysis-lab/promote-cli";
import { restoreBeforeSnapshot } from "../../apps/web/src/lib/server/analysis-lab/promotion-rollback";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
  type PromotionGrantSnapshot,
} from "../../apps/web/src/lib/server/analysis-serving/promotionSnapshot";
import { sha256Canonical } from "../../apps/web/src/lib/server/analysis-serving/promotionReleaseContract";

const FIXTURE = {
  grantId: "40000000-0000-4000-8000-000000000001",
  sourceId: "local-product-uat-confirmations",
  title: "격리 확인질문 인수 공고",
  rollbackPath: "confirmation-before-r2-snapshot.json",
} as const;

const action = readAction(process.argv.slice(2));
const socket = requiredEnv("PGHOST");
assert.match(realpathSync(socket), /^\/private\/var\/folders\/.+\/cunote-product-uat-pg-[a-zA-Z0-9]+$/);
assert.equal(process.env.DATABASE_URL, "postgres:///postgres");
assert.equal(process.env.PGUSER, "postgres");
const runtimeRoot = realpathSync(requiredEnv("CUNOTE_PRODUCT_UAT_RUNTIME_ROOT"));
assert.equal(realpathSync(socket), runtimeRoot);
const ownerMarker = JSON.parse(readFileSync(`${runtimeRoot}/.cunote-product-uat-owner.json`, "utf8"));
assert.equal(ownerMarker?.schema, "cunote-product-uat-runtime-owner-v1");
assert.equal(typeof ownerMarker?.id, "string");

const sql = postgres(requiredEnv("DATABASE_URL"), {
  max: 1,
  prepare: false,
  connection: { statement_timeout: 20_000 },
  onnotice: () => {},
});
const db = drizzle(sql, { schema });

try {
  const result = action === "r1"
    ? await publishInitialFixture()
    : action === "r2"
      ? await publishRevision2()
      : action === "withdraw"
        ? await publishWithdrawal()
        : action === "rollback"
          ? await rollbackRevision2()
          : await inspectFixture();
  console.log(JSON.stringify({ ok: true, action, ...result }));
} finally {
  await sql.end({ timeout: 5 });
}

async function publishInitialFixture() {
  const existing = await sql`select id from grants where id=${FIXTURE.grantId}`;
  assert.equal(existing.length, 0, "r1 fixture는 새 격리 DB에 한 번만 발행한다");
  await sql`insert into grants(id,source,source_id,title,status,serving_state,overall_confidence)
    values (${FIXTURE.grantId},'bizinfo',${FIXTURE.sourceId},${FIXTURE.title},'open','visible',1)`;
  await sql`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
    values ('bizinfo',${FIXTURE.sourceId},'{}','[]',${"c".repeat(64)},'normalized')`;
  const plans = await buildPlans();
  const publication = await createDrizzlePromotionPort(db, []).publishGrant(plans.r1);
  return { fixture: FIXTURE, publication, state: await inspectFixture() };
}

async function publishRevision2() {
  assert.deepEqual(await activePrompts(), ["기존 제외 질문", "최초 필수 질문"]);
  const before = await loadPromotionGrantSnapshot(db, FIXTURE.grantId, []);
  const plans = await buildPlans();
  const publication = await createDrizzlePromotionPort(db, []).publishGrant(plans.r2);
  const rollbackPath = `${runtimeRoot}/${FIXTURE.rollbackPath}`;
  writeFileSync(rollbackPath, `${JSON.stringify(before, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return {
    fixture: FIXTURE,
    publication,
    rollbackPath,
    beforeSnapshotSha256: promotionGrantSnapshotStateSha256(before),
    state: await inspectFixture(),
  };
}

async function publishWithdrawal() {
  assert.deepEqual(await activePrompts(), ["기존 제외 질문", "수정한 필수 질문", "추가한 우대 질문"]);
  const plans = await buildPlans();
  const publication = await createDrizzlePromotionPort(db, []).publishGrant(plans.withdraw);
  return { fixture: FIXTURE, publication, state: await inspectFixture() };
}

async function rollbackRevision2() {
  const rollbackPath = `${runtimeRoot}/${FIXTURE.rollbackPath}`;
  const before = JSON.parse(readFileSync(rollbackPath, "utf8")) as PromotionGrantSnapshot;
  assert.equal(before.grantId, FIXTURE.grantId);
  await db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, FIXTURE.grantId);
    await restoreBeforeSnapshot(tx, before);
  });
  const restored = await loadPromotionGrantSnapshot(db, FIXTURE.grantId, []);
  assert.equal(promotionGrantSnapshotStateSha256(restored), promotionGrantSnapshotStateSha256(before));
  return {
    fixture: FIXTURE,
    rollbackPath,
    restoredSnapshotSha256: promotionGrantSnapshotStateSha256(restored),
    state: await inspectFixture(),
  };
}

async function inspectFixture() {
  const questions = await sql<Array<{
    id: string;
    prompt: string;
    evaluation_contract_version: string | null;
    version: number;
    invalidated_at: Date | null;
  } & Record<string, unknown>>>`select *
    from grant_confirmation_questions where grant_id=${FIXTURE.grantId} order by prompt,id`;
  const answers = await sql<Array<{
    company_id: string;
    question_id: string;
    answer: unknown;
    disqualified: boolean;
    evaluation: string | null;
    answer_revision: number;
  } & Record<string, unknown>>>`select *
    from company_grant_confirmations where grant_id=${FIXTURE.grantId} order by company_id,question_id`;
  const canonical = {
    grantId: FIXTURE.grantId,
    questions: questions.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      contractVersion: row.evaluation_contract_version,
      version: row.version,
      active: row.invalidated_at === null,
    })),
    answers: answers.map((row) => ({
      companyId: row.company_id,
      questionId: row.question_id,
      answer: row.answer,
      disqualified: row.disqualified,
      evaluation: row.evaluation,
      answerRevision: row.answer_revision,
    })),
  };
  return {
    ...canonical,
    activePrompts: canonical.questions.filter((question) => question.active).map((question) => question.prompt).sort(),
    ledgerSha256: sha256Canonical({ grantId: FIXTURE.grantId, questions, answers }),
  };
}

async function activePrompts() {
  const rows = await sql<Array<{ prompt: string }>>`select prompt from grant_confirmation_questions
    where grant_id=${FIXTURE.grantId} and invalidated_at is null order by prompt`;
  return rows.map((row) => row.prompt);
}

async function buildPlans(): Promise<{ r1: GrantPromotionPlan; r2: GrantPromotionPlan; withdraw: GrantPromotionPlan }> {
  const source = await loadDeepAnalysisSourceBinding({ db, grantId: FIXTURE.grantId });
  assert.ok(source);
  const criteria: LabCriterion[] = [
    criterion("required", "필수 확인", "필수 조건을 직접 확인해야 합니다"),
    criterion("exclusion", "제외 확인", "현재 참여 제한 대상은 제외합니다"),
    criterion("preferred", "우대 확인", "우대 조건을 충족하면 가점합니다"),
  ];
  const run: LabRun = {
    runId: "run-2026-09-08T000000.000Z-localuat",
    grantId: FIXTURE.grantId,
    source: "bizinfo",
    sourceId: FIXTURE.sourceId,
    title: FIXTURE.title,
    model: "manual-fixture",
    promptVersion: "manual-fixture-v1",
    startedAt: "2026-09-08T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: createHash("sha256").update("local-product-uat-confirmations").digest("hex"),
    sourceRevisionSha256: source.sourceRevisionSha256,
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryValidationOutcome: "publishable",
    matchingReadiness: "conditional",
    error: null,
  };
  const review: LabReview = {
    grantId: FIXTURE.grantId,
    runId: run.runId,
    reviewerEmail: "reviewer@noten.im",
    createdAt: "2026-09-08T00:01:00.000Z",
    updatedAt: "2026-09-08T00:01:00.000Z",
    criterionReviews: criteria.map((_, criterionIndex) => ({ criterionIndex, verdict: "correct", note: null })),
    axisReviews: [],
    overallNote: null,
  };
  const options = [
    { value: "yes", label: "충족해요", evaluation: "satisfied" as const },
    { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" as const },
    { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" as const },
  ];
  const initial = buildManualConfirmationEvaluationsArtifact({
    run,
    review,
    questionAuthorEmail: "question-author@noten.im",
    createdAt: "2026-09-08T00:02:00.000Z",
    items: [{ criterionIndex: 0, resolutionScope: "per_notice", prompt: "최초 필수 질문", options }],
  });
  const selected1 = selected(initial);
  const revision2 = buildManualConfirmationEvaluationsRevisionArtifact({
    run,
    review,
    parent: selected1,
    questionAuthorEmail: "question-author@noten.im",
    createdAt: "2026-09-08T00:03:00.000Z",
    intent: "replace",
    withdrawnCriterionIndexes: [],
    items: [
      {
        criterionIndex: 0,
        resolutionScope: "per_notice",
        prompt: "수정한 필수 질문",
        options: [
          { value: "satisfied", label: "충족합니다", evaluation: "satisfied" },
          { value: "unsatisfied", label: "충족하지 않습니다", evaluation: "unsatisfied" },
          { value: "unknown", label: "확인할 수 없습니다", evaluation: "unknown" },
        ],
      },
      { criterionIndex: 2, resolutionScope: "per_notice", prompt: "추가한 우대 질문", options },
    ],
  });
  const selected2 = selected(revision2);
  const withdrawal = buildManualConfirmationEvaluationsRevisionArtifact({
    run,
    review,
    parent: selected2,
    questionAuthorEmail: "question-author@noten.im",
    createdAt: "2026-09-08T00:04:00.000Z",
    intent: "withdraw_all",
    withdrawnCriterionIndexes: [0, 2],
    items: [],
  });
  const legacy: LabConfirmationsFile = {
    schema: "lab-confirmations-v1",
    grantId: FIXTURE.grantId,
    runId: run.runId,
    model: "fixture",
    promptVersion: "confirmations-v2",
    createdAt: "2026-09-08T00:01:30.000Z",
    usage: null,
    costUsd: null,
    items: [{
      criterionIndex: 1,
      confirmation: {
        prompt: "기존 제외 질문",
        options: [
          { value: "restricted", label: "해당해요", disqualifies: true },
          { value: "clear", label: "해당하지 않아요", disqualifies: false },
        ],
        answerType: "single",
        reusable: "per_notice",
        conditionKey: null,
      },
    }],
  };
  const plan = (manual: SelectedManualConfirmationEvaluations) => planGrantPromotion({
    run,
    review,
    origin: "human",
    sidecar: legacy,
    manualEvaluationSidecar: manual.artifact,
    manualConfirmationEvaluationSelection: manual.selection,
    sourceRawSha256: source.sourceRawSha256,
  });
  return { r1: plan(selected1), r2: plan(selected2), withdraw: plan(selected(withdrawal)) };
}

function criterion(kind: LabCriterion["kind"], note: string, sourceSpan: string): LabCriterion {
  return {
    dimension: "other",
    kind,
    operator: "text_only",
    value: { note },
    confidence: 0.9,
    sourceSpan,
    spanVerified: true,
    note: null,
  };
}

function selected(artifact: ManualConfirmationEvaluationsArtifact): SelectedManualConfirmationEvaluations {
  return {
    artifact,
    selection: manualConfirmationEvaluationSelectionForArtifact(artifact),
    path: "/tmp/local-product-uat-confirmations.json",
    legacyShaOnly: false,
  };
}

function readAction(args: string[]): "r1" | "r2" | "withdraw" | "rollback" | "inspect" {
  assert.equal(args.length, 1, "--action=<r1|r2|withdraw|rollback|inspect> 하나가 필요합니다");
  const value = args[0]?.match(/^--action=(r1|r2|withdraw|rollback|inspect)$/)?.[1];
  assert.ok(value);
  return value as "r1" | "r2" | "withdraw" | "rollback" | "inspect";
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key}가 필요합니다.`);
  return value;
}

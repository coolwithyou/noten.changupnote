import assert from "node:assert/strict";
import type postgres from "postgres";
import postgresClient from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { GrantPromotionPlan } from "../analysis-lab/promote";
import {
  createPromotionReleaseManifest,
  planSha256,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleasePlanItem,
} from "../analysis-lab/promotion-release";
import * as schema from "../db/schema";
import {
  createDrizzleRepositories,
  loadPromotionServingRequestSnapshot,
  withPromotionServingReadSnapshot,
} from "./drizzle";

/** test-product-postgres의 전용 Unix socket cluster에서만 실행한다. */
export async function verifyPromotionServingSnapshotPostgres(input: {
  admin: postgres.Sql;
  socket: string;
}): Promise<void> {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/);

  const [grant] = await input.admin<{ id: string }[]>`
    select id::text as id
    from grants
    order by updated_at
    limit 1
  `;
  assert.ok(grant, "격리 harness가 먼저 만든 공고가 필요합니다");

  const releaseDbId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const runId = `run-2026-09-09T000000.000Z-${crypto.randomUUID().slice(0, 8)}`;
  const promotionPlan: GrantPromotionPlan = {
    grantId: grant.id,
    runId,
    title: "격리 promotion snapshot 공고",
    origin: "audited",
    auditState: "ai_audit_concur",
    criteria: [],
    criterionIndexByPosition: [],
    criterionStableKeys: [],
    resolutions: [],
    conversion: {
      grantId: grant.id,
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
  const releasePlanItem: PromotionReleasePlanItem = {
    grantId: grant.id,
    planSha256: planSha256(promotionPlan),
    promotionPlan,
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
  const manifest = createPromotionReleaseManifest({
    releaseId: `snapshot-postgres-${releaseDbId}`,
    revision: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    gitCommit: "4".repeat(40),
    buildDigest: "5".repeat(40),
    cohortLabel: "isolated-postgres",
    canaryGrantIds: [grant.id],
    sourceArtifacts: [{
      grantId: grant.id,
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
    plans: [releasePlanItem],
  });

  await input.admin`
    insert into analysis_lab_promotion_releases
      (id, release_id, manifest_sha256, release_plan_sha256, manifest,
       git_commit, build_digest, status, created_by)
    values
      (${releaseDbId}, ${manifest.releaseId}, ${manifest.manifestSha256},
       ${"a".repeat(64)}, ${JSON.stringify(manifest)}::jsonb, ${manifest.gitCommit},
       ${manifest.buildDigest}, 'active', 'isolated-postgres')
  `;
  await input.admin`
    insert into analysis_lab_promotion_items
      (id, release_db_id, grant_id, run_id, plan_sha256, before_snapshot,
       before_sha256, status, applied_at)
    values
      (${itemId}, ${releaseDbId}, ${grant.id}, ${runId}, ${releasePlanItem.planSha256},
       ${JSON.stringify({})}::jsonb, ${"b".repeat(64)}, 'applied', '2026-09-09T00:01:00Z')
  `;

  const db = drizzle(input.admin, { schema });
  const writer = postgresClient({
    host: input.socket,
    database: "postgres",
    username: "postgres",
    prepare: false,
    max: 1,
    onnotice: () => {},
  });
  let allowSecondRead!: () => void;
  let firstReadDone!: () => void;
  const secondReadGate = new Promise<void>((resolve) => { allowSecondRead = resolve; });
  const firstReadGate = new Promise<void>((resolve) => { firstReadDone = resolve; });
  try {
    const transaction = withPromotionServingReadSnapshot(db, async (session) => {
      const beforeRollback = await loadPromotionServingRequestSnapshot(session, [grant.id]);
      assert.equal(beforeRollback.items.some(({ item }) => item.releaseDbId === releaseDbId), true);
      assert.deepEqual(beforeRollback.metrics, {
        itemBindingRows: 1,
        releaseDocumentRows: 1,
        releaseManifestBytes: Buffer.byteLength(JSON.stringify(manifest)),
        releaseManifestValidations: 1,
      });
      firstReadDone();
      await secondReadGate;
      const afterConcurrentRollback = await loadPromotionServingRequestSnapshot(session, [grant.id]);
      assert.equal(
        afterConcurrentRollback.items.some(({ item }) => item.releaseDbId === releaseDbId),
        true,
        "동일 repeatable-read 요청은 중간 rollback의 item/manifest를 혼합하지 않는다",
      );
    });

    await Promise.race([
      firstReadGate,
      transaction.then(
        () => Promise.reject(new Error("promotion snapshot transaction이 두 번째 read 전에 끝났습니다")),
        (error) => Promise.reject(error),
      ),
    ]);
    try {
      await writer`
        update analysis_lab_promotion_releases
        set status = 'rolled_back', rolled_back_at = now()
        where id = ${releaseDbId}
      `;
    } finally {
      allowSecondRead();
    }
    await transaction;

    const afterRequest = await withPromotionServingReadSnapshot(
      db,
      (session) => loadPromotionServingRequestSnapshot(session, [grant.id]),
    );
    assert.equal(
      afterRequest.items.some(({ item }) => item.releaseDbId === releaseDbId),
      false,
      "다음 요청은 commit된 rollback을 즉시 반영한다",
    );

    await writer`
      update analysis_lab_promotion_releases
      set status = 'active', rolled_back_at = null
      where id = ${releaseDbId}
    `;
    const serving = await createDrizzleRepositories({ dialect: "drizzle", client: db })
      .grants.listActiveGrants({
        asOf: new Date("2026-09-09T00:02:00.000Z"),
        limit: 100,
        requireDeepAnalysisPromotion: true,
      });
    const hydrated = serving.find((entry) => entry.grant.id === grant.id);
    assert.ok(hydrated, "실제 grant repository가 검증된 local release를 같은 snapshot에서 hydrate해야 합니다");
    assert.equal(hydrated.authoring_readiness?.status, "unverified");
    assert.equal(hydrated.extraction_manifest?.reviewedAt, "2026-09-09T00:01:00.000Z");

    const unfilteredServing = await createDrizzleRepositories({ dialect: "drizzle", client: db })
      .grants.listActiveGrants({ asOf: new Date("2026-09-09T00:02:00.000Z"), limit: 100 });
    assert.ok(
      unfilteredServing.some((entry) => entry.grant.id === grant.id),
      "promotion 필터가 없는 목록도 현재 hydration 공고의 검수 projection을 보존한다",
    );
  } finally {
    await writer.end({ timeout: 5 });
  }

  console.log("PASS: promotion serving uses one validated release document in a repeatable-read request snapshot");
}

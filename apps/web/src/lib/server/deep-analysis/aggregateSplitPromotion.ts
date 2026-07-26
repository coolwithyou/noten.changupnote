import {
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";
import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";

import type { CunoteDb, CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  buildAggregateSplitChildDrafts,
  loadValidatedAggregateSplitBundle,
  sealAggregateSplitChildInput,
  type AggregateSplitChildDraft,
  type AggregateSplitCompletedCaseIdentity,
} from "./aggregateSplitMaterializer";
import { enqueueDeepAnalysisJob } from "./ledger";
import { sha256Hex, stableJson } from "./sourceRevision";

export const AGGREGATE_SPLIT_ACTIVE_FEEDER_BYPASS_REASON =
  "aggregate_split_staged_direct_enqueue" as const;

type AggregateSplitCase = typeof schema.grantAggregateSplitCases.$inferSelect;
type AggregateSplitChild = typeof schema.grantAggregateSplitChildren.$inferSelect;
type GrantInsert = typeof schema.grants.$inferInsert;
type GrantRow = typeof schema.grants.$inferSelect;
type GrantRawInsert = typeof schema.grantRaw.$inferInsert;
type GrantRawRow = typeof schema.grantRaw.$inferSelect;

export interface AggregateSplitPromotionPolicy {
  maxCasesPerInvocation: number;
  jobPriority: number;
}

export interface VerifiedAggregateSplitPromotionChild {
  childId: string;
  splitCaseId: string;
  stableKey: string;
  ordinal: number;
  sourceRevisionSha256: string;
  inputSha256: string;
  grantValues: GrantInsert;
  rawValues: GrantRawInsert;
}

export interface AggregateSplitPromotionResult {
  selected: number;
  staged: number;
  enqueued: number;
  retryPending: number;
  failed: number;
  lastFailure: {
    caseId: string;
    errorCode: string;
    retryable: boolean;
  } | null;
}

export function resolveAggregateSplitPromotionPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AggregateSplitPromotionPolicy {
  return {
    maxCasesPerInvocation: integerEnv(
      env.AGGREGATE_SPLIT_PROMOTION_MAX_CASES_PER_INVOCATION,
      1,
      1,
      3,
    ),
    jobPriority: integerEnv(
      env.AGGREGATE_SPLIT_DEEP_ANALYSIS_JOB_PRIORITY,
      200,
      1,
      1_000,
    ),
  };
}

/**
 * E-3A가 봉인한 모든 child를 다시 검증한 뒤에만 같은 UUID의 staged grant로 만든다.
 * R2 read는 transaction 밖에서 끝내고, grant/grant_raw/승격 evidence만 짧은 하나의
 * transaction으로 묶는다. 분석 job은 commit 뒤 기존 queue에 직접 enqueue한다.
 */
export async function runAggregateSplitPromotionInvocation(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  policy?: AggregateSplitPromotionPolicy;
  now?: () => Date;
}): Promise<AggregateSplitPromotionResult> {
  const policy = input.policy ?? resolveAggregateSplitPromotionPolicy();
  const now = input.now ?? (() => new Date());
  const result: AggregateSplitPromotionResult = {
    selected: 0,
    staged: 0,
    enqueued: 0,
    retryPending: 0,
    failed: 0,
    lastFailure: null,
  };

  for (let index = 0; index < policy.maxCasesPerInvocation; index += 1) {
    const splitCase = await findNextAggregateSplitPromotionCase(input.db);
    if (!splitCase) break;
    result.selected += 1;
    try {
      const promoted = await promotePreparedAggregateSplitCase({
        ...input,
        splitCase,
        policy,
        now,
      });
      result.staged += promoted.staged;
      result.enqueued += promoted.enqueued;
    } catch (error) {
      const failure = normalizePromotionFailure(error);
      await recordAggregateSplitPromotionFailure(input.db, {
        caseId: splitCase.id,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        now: now(),
      });
      if (failure.retryable) result.retryPending += 1;
      else result.failed += 1;
      result.lastFailure = {
        caseId: splitCase.id,
        errorCode: failure.code,
        retryable: failure.retryable,
      };
      // 같은 staged case를 한 invocation에서 반복 선택하지 않는다.
      break;
    }
  }
  return result;
}

export async function loadVerifiedAggregateSplitPromotionChildren(input: {
  storage: R2ObjectStorage;
  splitCase: AggregateSplitCase;
  children: AggregateSplitChild[];
}): Promise<VerifiedAggregateSplitPromotionChild[]> {
  assertPromotionCaseReady(input.splitCase, input.children);
  const splitCaseIdentity = completedCaseIdentityForPromotion(input.splitCase);
  const bundle = await loadValidatedAggregateSplitBundle({
    storage: input.storage,
    splitCase: splitCaseIdentity,
  });
  const drafts = buildAggregateSplitChildDrafts({
    splitCase: splitCaseIdentity,
    bundle,
  });
  return verifyPreparedAggregateSplitPromotionChildren({
    ...input,
    drafts,
  });
}

export async function verifyPreparedAggregateSplitPromotionChildren(input: {
  storage: R2ObjectStorage;
  splitCase: AggregateSplitCase;
  children: AggregateSplitChild[];
  drafts: AggregateSplitChildDraft[];
}): Promise<VerifiedAggregateSplitPromotionChild[]> {
  assertPromotionCaseReady(input.splitCase, input.children);
  const { drafts } = input;
  if (drafts.length !== input.children.length) {
    throw promotionError(
      "aggregate_split_promotion_draft_count_mismatch",
      "E-2 manifest를 재검증해 만든 draft 수가 E-3A child 수와 다릅니다.",
    );
  }
  const verified: VerifiedAggregateSplitPromotionChild[] = [];
  const orderedChildren = [...input.children].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  for (const [index, child] of orderedChildren.entries()) {
    const draft = drafts[index];
    if (!draft) {
      throw promotionError(
        "aggregate_split_promotion_draft_missing",
        `${child.stableKey}의 재생성 draft가 없습니다.`,
      );
    }
    verified.push(await loadVerifiedAggregateSplitPromotionChild({
      storage: input.storage,
      splitCase: input.splitCase,
      child,
      draft,
    }));
  }
  return verified;
}

async function findNextAggregateSplitPromotionCase(
  db: CunoteDbSession,
): Promise<AggregateSplitCase | null> {
  const [splitCase] = await db
    .select()
    .from(schema.grantAggregateSplitCases)
    .where(and(
      eq(schema.grantAggregateSplitCases.status, "completed"),
      eq(schema.grantAggregateSplitCases.materializationStatus, "prepared"),
      inArray(schema.grantAggregateSplitCases.promotionStatus, ["pending", "staged"]),
    ))
    .orderBy(
      asc(schema.grantAggregateSplitCases.updatedAt),
      asc(schema.grantAggregateSplitCases.id),
    )
    .limit(1);
  return splitCase ?? null;
}

async function promotePreparedAggregateSplitCase(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  splitCase: AggregateSplitCase;
  policy: AggregateSplitPromotionPolicy;
  now: () => Date;
}): Promise<{ staged: number; enqueued: number }> {
  const children = await input.db
    .select()
    .from(schema.grantAggregateSplitChildren)
    .where(eq(schema.grantAggregateSplitChildren.splitCaseId, input.splitCase.id))
    .orderBy(asc(schema.grantAggregateSplitChildren.ordinal));
  const verified = await loadVerifiedAggregateSplitPromotionChildren({
    storage: input.storage,
    splitCase: input.splitCase,
    children,
  });
  const stagedAt = input.now();
  await materializeVerifiedAggregateSplitChildren(input.db, {
    splitCase: input.splitCase,
    verified,
    stagedAt,
  });

  const enqueueFailures: Array<{ childId: string; message: string }> = [];
  for (const child of verified) {
    try {
      const job = await enqueueDeepAnalysisJob(input.db, {
        grantId: child.childId,
        sourceRevisionSha256: child.sourceRevisionSha256,
        modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
        priority: input.policy.jobPriority,
        sourceObservedAt: stagedAt,
      });
      const enqueuedAt = input.now();
      const [updated] = await input.db
        .update(schema.grantAggregateSplitChildren)
        .set({
          deepAnalysisJobId: job.id,
          deepAnalysisEnqueuedAt: enqueuedAt,
          activeFeederBypassReason: AGGREGATE_SPLIT_ACTIVE_FEEDER_BYPASS_REASON,
          promotionLastErrorCode: null,
          promotionLastErrorMessage: null,
          updatedAt: enqueuedAt,
        })
        .where(and(
          eq(schema.grantAggregateSplitChildren.id, child.childId),
          eq(schema.grantAggregateSplitChildren.splitCaseId, child.splitCaseId),
          eq(
            schema.grantAggregateSplitChildren.sourceRevisionSha256,
            child.sourceRevisionSha256,
          ),
          sql`${schema.grantAggregateSplitChildren.stagedGrantAt} IS NOT NULL`,
        ))
        .returning({ id: schema.grantAggregateSplitChildren.id });
      if (!updated) {
        throw new Error(`Staged aggregate split child evidence disappeared: ${child.childId}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      enqueueFailures.push({ childId: child.childId, message });
      await input.db
        .update(schema.grantAggregateSplitChildren)
        .set({
          promotionLastErrorCode: "aggregate_split_deep_analysis_enqueue_failed",
          promotionLastErrorMessage: message.slice(0, 2_000),
          updatedAt: input.now(),
        })
        .where(and(
          eq(schema.grantAggregateSplitChildren.id, child.childId),
          eq(schema.grantAggregateSplitChildren.splitCaseId, child.splitCaseId),
        ));
    }
  }

  const enqueued = await finalizeAggregateSplitEnqueueEvidence(input.db, {
    caseId: input.splitCase.id,
    expectedCount: verified.length,
    now: input.now(),
  });
  if (enqueueFailures.length > 0 || enqueued !== verified.length) {
    throw new AggregateSplitPromotionError(
      "aggregate_split_deep_analysis_enqueue_incomplete",
      `staged 자식 enqueue가 ${enqueued}/${verified.length}개입니다: ${
        enqueueFailures.map((failure) => failure.childId).join(", ")
      }`,
      true,
    );
  }
  return { staged: verified.length, enqueued };
}

async function loadVerifiedAggregateSplitPromotionChild(input: {
  storage: R2ObjectStorage;
  splitCase: AggregateSplitCase;
  child: AggregateSplitChild;
  draft: AggregateSplitChildDraft;
}): Promise<VerifiedAggregateSplitPromotionChild> {
  const { child, splitCase, draft } = input;
  if (
    child.status !== "prepared"
    || !child.inputArtifactKey
    || !child.inputSha256
    || !child.attachmentManifestSha256
    || child.inputChars === null
    || !child.preparedAt
  ) {
    throw promotionError(
      "aggregate_split_child_not_prepared",
      `${child.stableKey}에 E-3A prepared evidence가 없습니다.`,
    );
  }
  const inputArtifactBody = await input.storage.getObjectText(child.inputArtifactKey);
  if (sha256Hex(inputArtifactBody) !== child.inputSha256) {
    throw promotionError(
      "aggregate_split_child_input_readback_mismatch",
      `${child.stableKey} input artifact readback hash가 DB와 다릅니다.`,
    );
  }
  const resealed = sealAggregateSplitChildInput({
    childGrantId: child.id,
    draft,
  });
  if (
    resealed.inputArtifactBody !== inputArtifactBody
    || resealed.inputSha256 !== child.inputSha256
    || resealed.attachmentManifestSha256 !== child.attachmentManifestSha256
    || resealed.totalChars !== child.inputChars
  ) {
    throw promotionError(
      "aggregate_split_child_input_reseal_mismatch",
      `${child.stableKey} input artifact를 기존 seal 계약으로 재생성할 수 없습니다.`,
    );
  }
  if (
    child.stableKey !== draft.stableKey
    || child.ordinal !== draft.ordinal
    || child.source !== draft.source
    || child.sourceId !== draft.sourceId
    || child.title !== draft.title
    || child.agencyPrimary !== draft.agencyPrimary
    || child.manifestSha256 !== draft.manifestSha256
    || child.sourceRevisionSha256 !== draft.sourceRevisionSha256
    || child.rawPayloadSha256 !== draft.rawPayloadSha256
    || child.grantProjectionSha256 !== draft.grantProjectionSha256
    || sha256Hex(stableJson(child.grantProjection))
      !== child.grantProjectionSha256
    || stableJson(child.grantProjection) !== stableJson(draft.grantProjection)
    || child.manifestSha256 !== splitCase.manifestSha256
  ) {
    throw promotionError(
      "aggregate_split_child_projection_identity_mismatch",
      `${child.stableKey} projection/raw/source identity를 E-2 manifest에서 재생성할 수 없습니다.`,
    );
  }
  const grantFields = parseChildGrantFields(draft.grantSourceFields, child.stableKey);
  const matchingProjection = parseInitialMatchingProjection(
    requiredRecord(
      draft.grantProjection.initialMatchingProjection,
      `${child.stableKey}.initialMatchingProjection`,
    ),
    child.stableKey,
  );
  if (
    grantFields.source !== child.source
    || grantFields.sourceId !== child.sourceId
    || grantFields.title !== child.title
    || grantFields.agencyPrimary !== child.agencyPrimary
  ) {
    throw promotionError(
      "aggregate_split_child_source_revision_mismatch",
      `${child.stableKey} raw/grant/source revision 재계산 결과가 원장과 다릅니다.`,
    );
  }

  return {
    childId: child.id,
    splitCaseId: child.splitCaseId,
    stableKey: child.stableKey,
    ordinal: child.ordinal,
    sourceRevisionSha256: child.sourceRevisionSha256,
    inputSha256: child.inputSha256,
    grantValues: {
      id: child.id,
      ...grantFields,
      servingState: "staged",
      ...matchingProjection,
      embedding: null,
      modelVer: null,
      promptVer: null,
      parserVersion: null,
    },
    rawValues: {
      source: child.source,
      sourceId: child.sourceId,
      payload: draft.rawPayload,
      attachments: [],
      rawHash: child.rawPayloadSha256,
      status: "published",
    },
  };
}

async function materializeVerifiedAggregateSplitChildren(
  db: CunoteDb,
  input: {
    splitCase: AggregateSplitCase;
    verified: VerifiedAggregateSplitPromotionChild[];
    stagedAt: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
      FROM grant_aggregate_split_cases
      WHERE id = ${input.splitCase.id}::uuid
      FOR UPDATE
    `);
    const [lockedCase] = await tx
      .select()
      .from(schema.grantAggregateSplitCases)
      .where(eq(schema.grantAggregateSplitCases.id, input.splitCase.id))
      .limit(1);
    if (
      !lockedCase
      || lockedCase.status !== "completed"
      || lockedCase.materializationStatus !== "prepared"
      || !["pending", "staged", "enqueued"].includes(lockedCase.promotionStatus)
      || lockedCase.programCount !== input.verified.length
      || lockedCase.preparedChildCount !== input.verified.length
    ) {
      throw promotionError(
        "aggregate_split_promotion_case_changed",
        "승격 직전 case 상태 또는 child count가 검증 시점과 달라졌습니다.",
      );
    }
    const [parent] = await tx
      .select({
        id: schema.grants.id,
        servingState: schema.grants.servingState,
      })
      .from(schema.grants)
      .where(eq(schema.grants.id, lockedCase.grantId))
      .for("update")
      .limit(1);
    if (!parent || parent.servingState !== "visible") {
      throw promotionError(
        "aggregate_split_parent_not_visible",
        "E-3B-2 동안 parent는 visible 상태여야 합니다.",
      );
    }

    const lockedChildren = await tx
      .select()
      .from(schema.grantAggregateSplitChildren)
      .where(eq(schema.grantAggregateSplitChildren.splitCaseId, lockedCase.id))
      .orderBy(asc(schema.grantAggregateSplitChildren.ordinal))
      .for("update");
    assertVerifiedChildRowsUnchanged(lockedChildren, input.verified);

    await tx.insert(schema.grants)
      .values(input.verified.map((child) => ({
        ...child.grantValues,
        updatedAt: input.stagedAt,
      })))
      .onConflictDoNothing();
    await tx.insert(schema.grantRaw)
      .values(input.verified.map((child) => ({
        ...child.rawValues,
        collectedAt: input.stagedAt,
      })))
      .onConflictDoNothing();

    const childIds = input.verified.map((child) => child.childId);
    const grantRows = await tx
      .select()
      .from(schema.grants)
      .where(inArray(schema.grants.id, childIds));
    const rawRows = await tx
      .select()
      .from(schema.grantRaw)
      .where(inArray(
        schema.grantRaw.sourceId,
        input.verified.map((child) => child.rawValues.sourceId),
      ));
    assertExactStagedGrantRows(input.verified, grantRows, rawRows);

    await tx
      .update(schema.grantAggregateSplitChildren)
      .set({
        stagedGrantAt: sql`COALESCE(
          ${schema.grantAggregateSplitChildren.stagedGrantAt},
          ${input.stagedAt.toISOString()}::timestamptz
        )`,
        promotionLastErrorCode: null,
        promotionLastErrorMessage: null,
        updatedAt: input.stagedAt,
      })
      .where(and(
        eq(schema.grantAggregateSplitChildren.splitCaseId, lockedCase.id),
        inArray(schema.grantAggregateSplitChildren.id, childIds),
        eq(schema.grantAggregateSplitChildren.status, "prepared"),
      ));
    const existingEnqueuedCount = lockedChildren.filter(
      (child) => child.deepAnalysisJobId !== null,
    ).length;
    const alreadyEnqueued = existingEnqueuedCount === input.verified.length;
    await tx
      .update(schema.grantAggregateSplitCases)
      .set({
        promotionStatus: alreadyEnqueued ? "enqueued" : "staged",
        stagedChildCount: input.verified.length,
        enqueuedChildCount: existingEnqueuedCount,
        childrenStagedAt: sql`COALESCE(
          ${schema.grantAggregateSplitCases.childrenStagedAt},
          ${input.stagedAt.toISOString()}::timestamptz
        )`,
        childrenEnqueuedAt: alreadyEnqueued
          ? sql`COALESCE(
            ${schema.grantAggregateSplitCases.childrenEnqueuedAt},
            ${input.stagedAt.toISOString()}::timestamptz
          )`
          : null,
        activeFeederBypassReason: existingEnqueuedCount > 0
          ? AGGREGATE_SPLIT_ACTIVE_FEEDER_BYPASS_REASON
          : null,
        promotionLastErrorCode: null,
        promotionLastErrorMessage: null,
        updatedAt: input.stagedAt,
      })
      .where(eq(schema.grantAggregateSplitCases.id, lockedCase.id));
  });
}

async function finalizeAggregateSplitEnqueueEvidence(
  db: CunoteDbSession,
  input: {
    caseId: string;
    expectedCount: number;
    now: Date;
  },
): Promise<number> {
  const rows = await db
    .select({
      deepAnalysisJobId: schema.grantAggregateSplitChildren.deepAnalysisJobId,
    })
    .from(schema.grantAggregateSplitChildren)
    .where(eq(schema.grantAggregateSplitChildren.splitCaseId, input.caseId));
  const enqueuedCount = rows.filter((row) => row.deepAnalysisJobId !== null).length;
  const complete = rows.length === input.expectedCount
    && enqueuedCount === input.expectedCount;
  await db
    .update(schema.grantAggregateSplitCases)
    .set({
      promotionStatus: complete ? "enqueued" : "staged",
      enqueuedChildCount: enqueuedCount,
      childrenEnqueuedAt: complete ? input.now : null,
      activeFeederBypassReason: enqueuedCount > 0
        ? AGGREGATE_SPLIT_ACTIVE_FEEDER_BYPASS_REASON
        : null,
      promotionLastErrorCode: complete
        ? null
        : "aggregate_split_deep_analysis_enqueue_incomplete",
      promotionLastErrorMessage: complete
        ? null
        : `staged 자식 enqueue가 ${enqueuedCount}/${input.expectedCount}개입니다.`,
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.caseId),
      eq(schema.grantAggregateSplitCases.promotionStatus, "staged"),
    ));
  return enqueuedCount;
}

async function recordAggregateSplitPromotionFailure(
  db: CunoteDbSession,
  input: {
    caseId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    now: Date;
  },
): Promise<void> {
  const [splitCase] = await db
    .select({
      promotionStatus: schema.grantAggregateSplitCases.promotionStatus,
    })
    .from(schema.grantAggregateSplitCases)
    .where(eq(schema.grantAggregateSplitCases.id, input.caseId))
    .limit(1);
  if (!splitCase) return;
  if (splitCase.promotionStatus === "enqueued") return;
  const nextStatus = splitCase.promotionStatus === "staged"
    ? splitCase.promotionStatus
    : input.retryable ? "pending" : "failed";
  await db
    .update(schema.grantAggregateSplitCases)
    .set({
      promotionStatus: nextStatus,
      promotionLastErrorCode: input.errorCode,
      promotionLastErrorMessage: input.errorMessage.slice(0, 2_000),
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.caseId),
      eq(
        schema.grantAggregateSplitCases.promotionStatus,
        splitCase.promotionStatus,
      ),
    ));
}

function assertPromotionCaseReady(
  splitCase: AggregateSplitCase,
  children: AggregateSplitChild[],
): void {
  if (
    splitCase.status !== "completed"
    || splitCase.materializationStatus !== "prepared"
    || !["pending", "staged", "enqueued"].includes(splitCase.promotionStatus)
    || !splitCase.manifestSha256
    || splitCase.programCount === null
    || splitCase.programCount < 2
    || splitCase.programCount !== splitCase.preparedChildCount
    || children.length !== splitCase.programCount
  ) {
    throw promotionError(
      "aggregate_split_promotion_not_ready",
      "모든 E-3A child가 prepared인 완료 case만 staged 승격할 수 있습니다.",
    );
  }
  for (const [ordinal, child] of [...children]
    .sort((left, right) => left.ordinal - right.ordinal)
    .entries()) {
    if (
      child.splitCaseId !== splitCase.id
      || child.parentGrantId !== splitCase.grantId
      || child.ordinal !== ordinal
      || child.manifestSha256 !== splitCase.manifestSha256
      || child.status !== "prepared"
    ) {
      throw promotionError(
        "aggregate_split_promotion_child_set_mismatch",
        "prepared child의 case/parent/ordinal/manifest identity가 정확히 일치하지 않습니다.",
      );
    }
  }
}

function completedCaseIdentityForPromotion(
  splitCase: AggregateSplitCase,
): AggregateSplitCompletedCaseIdentity {
  if (
    !splitCase.inputArtifactKey
    || !splitCase.inputSha256
    || !splitCase.manifestArtifactKey
    || !splitCase.manifestSha256
    || !splitCase.model
    || splitCase.segmentCount === null
    || splitCase.programCount === null
  ) {
    throw promotionError(
      "aggregate_split_promotion_case_identity_incomplete",
      "E-2 input/manifest/model/count evidence가 없어 child를 재검증할 수 없습니다.",
    );
  }
  return {
    id: splitCase.id,
    grantId: splitCase.grantId,
    sourceRevisionSha256: splitCase.sourceRevisionSha256,
    inputArtifactKey: splitCase.inputArtifactKey,
    inputSha256: splitCase.inputSha256,
    manifestArtifactKey: splitCase.manifestArtifactKey,
    manifestSha256: splitCase.manifestSha256,
    model: splitCase.model,
    segmentCount: splitCase.segmentCount,
    programCount: splitCase.programCount,
  };
}

function assertVerifiedChildRowsUnchanged(
  actual: AggregateSplitChild[],
  expected: VerifiedAggregateSplitPromotionChild[],
): void {
  if (actual.length !== expected.length) {
    throw promotionError(
      "aggregate_split_promotion_child_set_changed",
      "R2 검증 뒤 transaction에서 child count가 달라졌습니다.",
    );
  }
  for (const [index, child] of actual.entries()) {
    const verified = expected[index];
    if (
      !verified
      || child.id !== verified.childId
      || child.splitCaseId !== verified.splitCaseId
      || child.stableKey !== verified.stableKey
      || child.ordinal !== verified.ordinal
      || child.status !== "prepared"
      || child.sourceRevisionSha256 !== verified.sourceRevisionSha256
      || child.inputSha256 !== verified.inputSha256
    ) {
      throw promotionError(
        "aggregate_split_promotion_child_set_changed",
        "R2 검증 뒤 transaction에서 child identity가 달라졌습니다.",
      );
    }
  }
}

function assertExactStagedGrantRows(
  expected: VerifiedAggregateSplitPromotionChild[],
  grants: GrantRow[],
  rawRows: GrantRawRow[],
): void {
  const grantById = new Map(grants.map((grant) => [grant.id, grant]));
  const rawByIdentity = new Map(
    rawRows.map((raw) => [`${raw.source}\u0000${raw.sourceId}`, raw]),
  );
  const expectedRawIdentities = new Set(expected.map(
    (child) => `${child.rawValues.source}\u0000${child.rawValues.sourceId}`,
  ));
  const matchingRawRows = rawRows.filter(
    (raw) => expectedRawIdentities.has(`${raw.source}\u0000${raw.sourceId}`),
  );
  if (
    grants.length !== expected.length
    || matchingRawRows.length !== expected.length
  ) {
    throw promotionError(
      "aggregate_split_staged_grant_count_mismatch",
      "staged grants/grant_raw exact count가 prepared child 수와 다릅니다.",
    );
  }
  for (const child of expected) {
    const grant = grantById.get(child.childId);
    const raw = rawByIdentity.get(
      `${child.rawValues.source}\u0000${child.rawValues.sourceId}`,
    );
    if (
      !grant
      || !raw
      || stableJson(grantPromotionIdentity(grant))
        !== stableJson(grantPromotionIdentity(child.grantValues))
      || stableJson(rawPromotionIdentity(raw))
        !== stableJson(rawPromotionIdentity(child.rawValues))
    ) {
      throw promotionError(
        "aggregate_split_staged_grant_identity_mismatch",
        `${child.stableKey}의 grants/grant_raw readback이 봉인 projection과 다릅니다.`,
      );
    }
  }
}

function grantPromotionIdentity(
  grant: GrantInsert | GrantRow,
): Record<string, unknown> {
  return {
    id: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    url: grant.url ?? null,
    agencyJurisdiction: grant.agencyJurisdiction ?? null,
    agencyOperator: grant.agencyOperator ?? null,
    agencyPrimary: grant.agencyPrimary ?? null,
    categoryL1: grant.categoryL1 ?? null,
    categoryL2: grant.categoryL2 ?? null,
    applyStart: normalizeDate(grant.applyStart ?? null),
    applyEnd: normalizeDate(grant.applyEnd ?? null),
    applyMethod: grant.applyMethod ?? null,
    supportAmount: grant.supportAmount ?? null,
    benefits: grant.benefits ?? null,
    requiredDocuments: grant.requiredDocuments ?? null,
    status: grant.status,
    servingState: grant.servingState ?? "visible",
    fRegions: grant.fRegions ?? [],
    fIndustries: grant.fIndustries ?? [],
    fBizAgeMinMonths: grant.fBizAgeMinMonths ?? null,
    fBizAgeMaxMonths: grant.fBizAgeMaxMonths ?? null,
    fSizes: grant.fSizes ?? [],
    fFounderTraits: grant.fFounderTraits ?? [],
    fRequiredCerts: grant.fRequiredCerts ?? [],
    fApplyMethods: grant.fApplyMethods ?? [],
    fAuthoringMode: grant.fAuthoringMode ?? "unknown",
    embedding: grant.embedding ?? null,
    overallConfidence: grant.overallConfidence,
    modelVer: grant.modelVer ?? null,
    promptVer: grant.promptVer ?? null,
    parserVersion: grant.parserVersion ?? null,
  };
}

function rawPromotionIdentity(
  raw: GrantRawInsert | GrantRawRow,
): Record<string, unknown> {
  return {
    source: raw.source,
    sourceId: raw.sourceId,
    payload: raw.payload,
    attachments: raw.attachments ?? null,
    rawHash: raw.rawHash ?? null,
    status: raw.status,
  };
}

function parseChildGrantFields(
  grant: Record<string, unknown>,
  stableKey: string,
): Omit<
  GrantInsert,
  | "id"
  | "servingState"
  | "fRegions"
  | "fIndustries"
  | "fBizAgeMinMonths"
  | "fBizAgeMaxMonths"
  | "fSizes"
  | "fFounderTraits"
  | "fRequiredCerts"
  | "fApplyMethods"
  | "fAuthoringMode"
  | "embedding"
  | "overallConfidence"
  | "modelVer"
  | "promptVer"
  | "parserVersion"
> {
  if (
    grant.supportAmount !== null
    || grant.benefits !== null
    || grant.requiredDocuments !== null
  ) {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${stableKey} 초기 grant는 분석 전 파생 필드를 포함할 수 없습니다.`,
    );
  }
  return {
    source: requiredEnum(grant.source, ["kstartup", "bizinfo", "bizinfo_event"], "source"),
    sourceId: requiredString(grant.sourceId, "sourceId"),
    title: requiredString(grant.title, "title"),
    url: nullableString(grant.url, "url"),
    agencyJurisdiction: nullableString(grant.agencyJurisdiction, "agencyJurisdiction"),
    agencyOperator: nullableString(grant.agencyOperator, "agencyOperator"),
    agencyPrimary: nullableString(grant.agencyPrimary, "agencyPrimary"),
    categoryL1: nullableString(grant.categoryL1, "categoryL1"),
    categoryL2: nullableString(grant.categoryL2, "categoryL2"),
    applyStart: nullableDate(grant.applyStart, "applyStart"),
    applyEnd: nullableDate(grant.applyEnd, "applyEnd"),
    applyMethod: nullableStringRecord(grant.applyMethod, "applyMethod"),
    supportAmount: null,
    benefits: null,
    requiredDocuments: null,
    status: requiredEnum(grant.status, ["upcoming", "open", "closed", "unknown"], "status"),
  };
}

function parseInitialMatchingProjection(
  projection: Record<string, unknown>,
  stableKey: string,
): Pick<
  GrantInsert,
  | "fRegions"
  | "fIndustries"
  | "fBizAgeMinMonths"
  | "fBizAgeMaxMonths"
  | "fSizes"
  | "fFounderTraits"
  | "fRequiredCerts"
  | "fApplyMethods"
  | "fAuthoringMode"
  | "overallConfidence"
> {
  const expected = {
    fRegions: [],
    fIndustries: [],
    fBizAgeMinMonths: null,
    fBizAgeMaxMonths: null,
    fSizes: [],
    fFounderTraits: [],
    fRequiredCerts: [],
    fApplyMethods: [],
    fAuthoringMode: "deep_analysis_pending",
    overallConfidence: 0,
  };
  if (stableJson(projection) !== stableJson(expected)) {
    throw promotionError(
      "aggregate_split_child_matching_projection_invalid",
      `${stableKey} 초기 matching projection이 분석 대기 계약과 다릅니다.`,
    );
  }
  return expected;
}

export class AggregateSplitPromotionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AggregateSplitPromotionError";
  }
}

function promotionError(code: string, message: string): AggregateSplitPromotionError {
  return new AggregateSplitPromotionError(code, message, false);
}

function normalizePromotionFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AggregateSplitPromotionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "aggregate_split_promotion_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${label}가 object가 아닙니다.`,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${label}가 올바른 문자열이 아닙니다.`,
    );
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${label}가 문자열 또는 null이 아닙니다.`,
    );
  }
  return value;
}

function nullableDate(value: unknown, label: string): Date | null {
  const text = nullableString(value, label);
  if (text === null) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${label}가 canonical ISO timestamp가 아닙니다.`,
    );
  }
  return date;
}

function nullableStringRecord(
  value: unknown,
  label: string,
): Record<string, string | null> | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || Object.values(value).some(
      (item) => item !== null && typeof item !== "string",
    )
  ) {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${label}가 string/null record가 아닙니다.`,
    );
  }
  return value as Record<string, string | null>;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw promotionError(
      "aggregate_split_child_grant_contract_invalid",
      `${label} 값이 허용 목록에 없습니다.`,
    );
  }
  return value as T[number];
}

function normalizeDate(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected integer between ${min} and ${max}, received ${raw}`);
  }
  return parsed;
}

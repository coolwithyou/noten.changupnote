import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBindings } from "../deep-analysis/prepareInput";
import { isKStartupRecruitmentClosedPayload } from "../repositories/activeGrantFilter";
import { LabGrantNotFoundError, prepareLabAnalysis } from "./analyze";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import { resolveLabModel } from "./extractor";
import {
  encodeCanonical,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchAnalysisMode,
  type AnalysisLaunchTerminalRepairBinding,
} from "./launch-batch-artifacts";
import { readTerminalRepairSource } from "./terminal-repair-source";
import { classifyNoticePeriod, kstDayStartUtc } from "./notice-period";
import { findMonorepoRoot } from "./run-store";
import { stratumIdOf, thicknessTierOf } from "./strata";
import {
  CURRENT_INVENTORY_SCHEMA,
  MATCHING_CAMPAIGN_POLICY,
  MISSING_WORKSPACE_FIELDS_POLICY,
  TERMINAL_REPAIR_POLICY,
  buildCurrentInventoryLaunchManifest,
  storeCurrentLaunchInventory,
  type CurrentLaunchInventory,
  type CurrentInventoryPolicy,
} from "./current-inventory-launch";
import type { MatchingInventoryClassification } from "./matching-inventory-campaign";

/** 명시된 최대 100건만 읽는다. 모델 호출과 runtime lease, 서비스 DB/R2 쓰기는 하지 않는다. */
export async function prepareCurrentInventoryLaunch(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
  readonly analysisMode?: Exclude<AnalysisLaunchAnalysisMode, "application_only">;
}) {
  return prepareExactInventory(input, "open-visible-current-period-unseen-v1");
}

/** campaign 분류가 current material 변경을 확인한 exact target을 기존 current 경로로 재봉인한다. */
export async function prepareMatchingCampaignLaunch(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
  readonly classification: MatchingInventoryClassification;
  readonly classificationSha256: string;
}) {
  const actualClassificationSha256 = createHash("sha256")
    .update(encodeCanonical(input.classification)).digest("hex");
  if (actualClassificationSha256 !== input.classificationSha256) {
    throw new Error("matching campaign classification SHA가 다릅니다.");
  }
  const entries = new Map(input.classification.entries.map((entry) => [entry.grantId, entry]));
  for (const grantId of input.grantIds) {
    const entry = entries.get(grantId);
    if (!entry?.campaignEligible
      || (entry.category !== "new" && entry.category !== "source_changed" && entry.category !== "prepared_not_started")
      || !entry.current.inputSha256
      || !entry.current.attachmentManifestSha256
      || !/^[a-f0-9]{64}$/u.test(entry.current.inputSha256)
      || !/^[a-f0-9]{64}$/u.test(entry.current.attachmentManifestSha256)) {
      throw new Error(`matching campaign classification이 current 준비를 허용하지 않습니다: ${grantId}`);
    }
  }
  return prepareExactInventory({
    grantIds: input.grantIds,
    concurrency: input.concurrency,
    analysisMode: "matching_only",
    expectedMatchingCampaignClassification: input.classification,
  }, MATCHING_CAMPAIGN_POLICY);
}

/** 기존 공고 중 필드가 전혀 없는 exact 대상의 보완 준비. live 권한은 발급하지 않는다. */
export async function prepareMissingWorkspaceFieldsLaunch(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
  readonly analysisMode?: Exclude<AnalysisLaunchAnalysisMode, "application_only">;
}) {
  return prepareExactInventory(input, MISSING_WORKSPACE_FIELDS_POLICY);
}

export async function prepareTerminalRepairLaunch(input: {
  sourceManifestSha256: string;
  sourceGrantSha256: string;
  concurrency: number;
  analysisMode?: Exclude<AnalysisLaunchAnalysisMode, "application_only">;
}) {
  const source = await readTerminalRepairSource(findMonorepoRoot(), input.sourceManifestSha256, input.sourceGrantSha256);
  const result = await prepareExactInventory({
    grantIds: source.selected.map(t => t.grantId),
    concurrency: input.concurrency,
    ...(input.analysisMode ? { analysisMode: input.analysisMode } : {}),
  }, TERMINAL_REPAIR_POLICY, source.binding);
  return { ...result, sourceTargetCount: source.manifest.targets.length,
    preservedTargetCount: source.manifest.targets.length - source.selected.length,
    originalSequences: source.binding.originalSequences };
}

async function prepareExactInventory(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
  readonly analysisMode?: Exclude<AnalysisLaunchAnalysisMode, "application_only">;
  readonly expectedMatchingCampaignClassification?: MatchingInventoryClassification;
}, policy: CurrentInventoryPolicy, terminalRepair?: AnalysisLaunchTerminalRepairBinding) {
  if ((policy === TERMINAL_REPAIR_POLICY) !== Boolean(terminalRepair)) throw new Error("terminal repair ancestry가 필요합니다.");
  if (input.grantIds.length < 1 || input.grantIds.length > 100
    || new Set(input.grantIds).size !== input.grantIds.length
    || input.grantIds.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))
    || !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) {
    throw new Error("current inventory는 중복 없는 UUID 1~100건과 concurrency 1~4가 필요합니다.");
  }
  const root = findMonorepoRoot();
  const provenance = await readCurrentDeepRepairExecutionProvenance();
  const history = await readDeepRepairHistoricalGrantIds({ scope: "all" });
  if (policy !== TERMINAL_REPAIR_POLICY) assertCurrentInventoryHistoryEligibility(input.grantIds, history, policy);
  const before = await readCurrentEligibility(input.grantIds, policy);
  const prepared = [];
  for (const grantId of input.grantIds) prepared.push(await prepareLabAnalysis(grantId));
  const after = await readCurrentEligibility(input.grantIds, policy);
  if (!encodeCanonical(before).equals(encodeCanonical(after))) {
    throw new Error("current inventory 준비 중 원천 결속이 변경됐습니다.");
  }
  const historyAfter = await readDeepRepairHistoricalGrantIds({ scope: "all" });
  if (!encodeCanonical(history).equals(encodeCanonical(historyAfter))) {
    throw new Error("current inventory 준비 중 과거 이력이 변경됐습니다.");
  }
  const now = new Date();
  const inventory: CurrentLaunchInventory = {
    schema: CURRENT_INVENTORY_SCHEMA,
    seriesId: `current-${policy === TERMINAL_REPAIR_POLICY ? "terminal-repair-" : policy === MISSING_WORKSPACE_FIELDS_POLICY ? "field-repair-" : policy === MATCHING_CAMPAIGN_POLICY ? "matching-campaign-" : ""}${kstDayStartUtc(now).toISOString().slice(0, 10).replaceAll("-", "")}`,
    observedAt: now.toISOString(), model: resolveLabModel(),
    policy,
    historicalGrantIdsSha256: createHash("sha256").update(encodeCanonical(history)).digest("hex"),
    targets: prepared.map((item, sequence) => {
      const row = after.find(row => row.grantId === item.grant.id);
      if (!row) throw new Error("current inventory target이 없습니다.");
      return { sequence, grantId: item.grant.id, stratum: row.stratum,
        inputSha256: item.input.inputSha256,
        attachmentManifestSha256: item.input.attachmentManifestSha256,
        sourceRevisionSha256: row.sourceRevisionSha256,
        ...(input.analysisMode === "matching_only" ? {
          matchingMaterialSourceBinding: {
            schema: "analysis-matching-material-source-binding-v1" as const,
            materialSourceRevisionSha256: row.materialSourceRevisionSha256,
            sourceRawSha256: row.sourceRawSha256,
          },
        } : {}),
      };
    }),
  };
  if (input.expectedMatchingCampaignClassification) {
    const expected = new Map(input.expectedMatchingCampaignClassification.entries.map((entry) => [entry.grantId, entry]));
    for (const target of inventory.targets) {
      const entry = expected.get(target.grantId);
      if (!entry?.campaignEligible
        || target.inputSha256 !== entry.current.inputSha256
        || target.attachmentManifestSha256 !== entry.current.attachmentManifestSha256) {
        throw new Error(`matching campaign current material이 classification과 다릅니다: ${target.grantId}`);
      }
    }
  }
  // DB 읽기와 별도로 물리적인 입력 byte 재조립을 한 번 더 대조한다.
  for (const target of inventory.targets) {
    const current = await prepareLabAnalysis(target.grantId);
    if (current.input.inputSha256 !== target.inputSha256
      || current.input.attachmentManifestSha256 !== target.attachmentManifestSha256) {
      throw new Error("current inventory 입력/첨부가 재조회에서 변경됐습니다.");
    }
  }
  const final = await readCurrentEligibility(input.grantIds, policy);
  if (!encodeCanonical(final).equals(encodeCanonical(after))) {
    throw new Error("current inventory 봉인 직전 원천 결속이 변경됐습니다.");
  }
  const currentProvenance = await readCurrentDeepRepairExecutionProvenance();
  if (!encodeCanonical(currentProvenance).equals(encodeCanonical(provenance))) {
    throw new Error("current inventory 준비 중 실행 코드가 변경됐습니다.");
  }
  if (!encodeCanonical(history).equals(encodeCanonical(await readDeepRepairHistoricalGrantIds({ scope: "all" })))) {
    throw new Error("current inventory 봉인 직전 과거 이력이 변경됐습니다.");
  }
  const inventorySha256 = createHash("sha256").update(encodeCanonical(inventory)).digest("hex");
  const manifest = buildCurrentInventoryLaunchManifest({ inventory, inventorySha256,
    provenance, concurrency: input.concurrency, now: new Date(),
    ...(input.analysisMode ? { analysisMode: input.analysisMode } : {}),
    ...(terminalRepair ? { terminalRepair } : {}) });
  if (terminalRepair) {
    const latest = await readTerminalRepairSource(root, terminalRepair.sourceManifestSha256, terminalRepair.sourceGrantSha256);
    if (!encodeCanonical(latest.binding).equals(encodeCanonical(terminalRepair))) throw new Error("준비 중 terminal receipt 집합이 변경됐습니다.");
  }
  const stored = await storeCurrentLaunchInventory(root, inventory);
  const launch = await writeAnalysisLaunchArtifact("manifests", manifest, root);
  return { manifest, manifestSha256: launch.sha256, path: launch.path,
    inventorySha256: stored.sha256, inventoryPath: stored.path,
    policy, historicalExcluded: policy === MISSING_WORKSPACE_FIELDS_POLICY || policy === TERMINAL_REPAIR_POLICY ? 0 : history.length,
    modelCalls: 0, serviceWrites: 0,
    liveExecutionAuthorized: false };
}

/** 신규 재고 target 착수 직전에 현행 지원 조건과 봉인 원천을 다시 확인한다. */
export async function verifyCurrentInventoryLaunchTarget(
  inventory: CurrentLaunchInventory,
  grantId: string,
  readEligibility: (ids: readonly string[], policy: CurrentInventoryPolicy) => Promise<readonly {
    grantId: string;
    sourceRevisionSha256: string;
    materialSourceRevisionSha256?: string;
  }[]> = readCurrentEligibility,
  analysisMode: AnalysisLaunchAnalysisMode = "primary_and_application",
) {
  const target = inventory.targets.find(item => item.grantId === grantId);
  if (!target) throw new Error("current inventory 밖의 target입니다.");
  const rows = await readEligibility([grantId], inventory.policy);
  const row = rows[0];
  const matchingMaterialBinding = analysisMode === "matching_only"
    ? target.matchingMaterialSourceBinding
    : undefined;
  const sourceMatches = matchingMaterialBinding
    ? row?.materialSourceRevisionSha256 === matchingMaterialBinding.materialSourceRevisionSha256
    : row?.sourceRevisionSha256 === target.sourceRevisionSha256;
  if (rows.length !== 1 || row?.grantId !== grantId || !sourceMatches) {
    throw new Error("current inventory target 원천이 변경됐습니다.");
  }
}

export function assertCurrentInventoryHistoryEligibility(
  grantIds: readonly string[], history: readonly string[], policy: CurrentInventoryPolicy,
) {
  if (policy === MISSING_WORKSPACE_FIELDS_POLICY || policy === MATCHING_CAMPAIGN_POLICY) return;
  if (policy !== "open-visible-current-period-unseen-v1") throw new Error("알 수 없는 inventory 정책입니다.");
  const historySet = new Set(history);
  if (grantIds.some(id => historySet.has(id))) throw new Error("current inventory에 과거 이력이 포함됐습니다.");
}

export function assertMissingWorkspaceFieldsState(input: { fieldCount: number; editableSurfaceCount: number }) {
  if (input.fieldCount !== 0 || !Number.isSafeInteger(input.editableSurfaceCount) || input.editableSurfaceCount < 1) {
    throw new Error("누락 필드 보완은 필드 0개이며 보관 HWP/HWPX 양식이 준비된 공고만 허용합니다.");
  }
}

export interface CurrentEligibleMatchingTarget {
  readonly grantId: string;
  readonly inputSha256: string | null;
  readonly attachmentManifestSha256: string | null;
  readonly closesToday: boolean;
  /** target-local input failure only; shared DB/storage failures reject the snapshot. */
  readonly preparationFailure?: "grant_missing" | "input_integrity";
}

export type CurrentEligibleMatchingCandidate = Pick<CurrentEligibleMatchingTarget, "grantId" | "closesToday">;

export function isCurrentEligibleMatchingTargetClosingToday(applyEnd: Date | null, asOf: Date): boolean {
  return applyEnd instanceof Date
    && Number.isFinite(applyEnd.getTime())
    && applyEnd.getTime() === kstDayStartUtc(asOf).getTime();
}

/** 고정 시각의 지원 가능·노출·중복 대표 모집단만 읽는다. */
export async function readCurrentEligibleMatchingCandidates(
  asOf: Date = new Date(),
): Promise<readonly CurrentEligibleMatchingCandidate[]> {
  if (!Number.isFinite(asOf.getTime())) throw new Error("campaign snapshot 시각이 잘못됐습니다.");
  const db = getCunoteDb();
  const candidates = await db.transaction(async tx => {
    const rows = await tx.select({
      id: schema.grants.id,
      source: schema.grants.source,
      applyStart: schema.grants.applyStart,
      applyEnd: schema.grants.applyEnd,
      payload: schema.grantRaw.payload,
    }).from(schema.grants).leftJoin(schema.grantRaw, and(
      eq(schema.grants.source, schema.grantRaw.source),
      eq(schema.grants.sourceId, schema.grantRaw.sourceId),
    )).where(and(
      eq(schema.grants.status, "open"),
      eq(schema.grants.servingState, "visible"),
    ));
    const candidateRows = rows.filter((row) => (
      (row.source === "bizinfo" || row.source === "kstartup")
      && classifyNoticePeriod(row.applyStart, row.applyEnd, asOf) === "eligible"
      && !isKStartupRecruitmentClosedPayload(row.source, row.payload)
    ));
    if (candidateRows.length === 0) return [];
    const members = await tx.select({ id: schema.dedupLinks.memberGrantId })
      .from(schema.dedupLinks).where(and(
        eq(schema.dedupLinks.confirmed, true),
        inArray(schema.dedupLinks.memberGrantId, candidateRows.map((row) => row.id)),
      ));
    const memberIds = new Set(members.map((row) => row.id));
    return candidateRows.filter((row) => !memberIds.has(row.id))
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  return Object.freeze(candidates.map((row) => Object.freeze({
    grantId: row.id,
    closesToday: isCurrentEligibleMatchingTargetClosingToday(row.applyEnd, asOf),
  })));
}

/** 선택한 공고만 물리 입력을 조립한다. 다른 종류의 실패는 공유 장애 가능성이 있어 중단한다. */
export async function prepareCurrentEligibleMatchingTargets(
  candidates: readonly CurrentEligibleMatchingCandidate[],
  prepare: (grantId: string) => Promise<{
    grant: { id: string };
    input: { inputSha256: string; attachmentManifestSha256: string };
  }> = prepareLabAnalysis,
): Promise<ReadonlyMap<string, CurrentEligibleMatchingTarget>> {
  const result = new Map<string, CurrentEligibleMatchingTarget>();
  for (let offset = 0; offset < candidates.length; offset += 2) {
    const batch = await Promise.all(candidates.slice(offset, offset + 2).map(async (candidate) => {
      try {
        const current = await prepare(candidate.grantId);
        if (current.grant.id !== candidate.grantId) {
          throw new Error(`입력 준비 target 결속이 다릅니다: ${candidate.grantId}`);
        }
        return Object.freeze({
          ...candidate,
          inputSha256: current.input.inputSha256,
          attachmentManifestSha256: current.input.attachmentManifestSha256,
        });
      } catch (error) {
        const preparationFailure = error instanceof LabGrantNotFoundError
          ? "grant_missing" as const
          : error instanceof Error && (
            error.message === "markdown SHA-256 mismatch"
            || error.message === "attachment preparation provenance length mismatch"
            || error.message.startsWith("attachment preparation outcome unresolved:")
            || error.message.startsWith("attachment provenance outcome unresolved:")
          )
            ? "input_integrity" as const
            : null;
        if (!preparationFailure) throw error;
        return Object.freeze({
          ...candidate,
          inputSha256: null,
          attachmentManifestSha256: null,
          preparationFailure,
        });
      }
    }));
    for (const target of batch) result.set(target.grantId, target);
  }
  return result;
}

/** 기존 직접 호출자는 모든 현행 대상의 exact material을 요청한다. */
export async function readCurrentEligibleMatchingTargets(
  asOf: Date = new Date(),
): Promise<readonly CurrentEligibleMatchingTarget[]> {
  const candidates = await readCurrentEligibleMatchingCandidates(asOf);
  const prepared = await prepareCurrentEligibleMatchingTargets(candidates);
  return Object.freeze(candidates.map((candidate) => prepared.get(candidate.grantId)!));
}

export async function readCurrentEligibility(grantIds: readonly string[], policy: CurrentInventoryPolicy) {
  const db = getCunoteDb();
  return db.transaction(async tx => {
    const now = new Date();
    const rows = await tx.select({ grant: schema.grants, payload: schema.grantRaw.payload })
      .from(schema.grants).leftJoin(schema.grantRaw, and(
        eq(schema.grants.source, schema.grantRaw.source), eq(schema.grants.sourceId, schema.grantRaw.sourceId),
      )).where(inArray(schema.grants.id, [...grantIds]));
    const members = await tx.select({ id: schema.dedupLinks.memberGrantId }).from(schema.dedupLinks)
      .where(and(eq(schema.dedupLinks.confirmed, true), inArray(schema.dedupLinks.memberGrantId, [...grantIds])));
    const bytes = await tx.select({ grantId: schema.grants.id,
      maxBytes: sql<number>`coalesce(max(case when ${schema.grantAttachmentArchives.markdownStorageKey} is not null then ${schema.grantAttachmentArchives.markdownBytes} else 0 end), 0)`,
    }).from(schema.grants).leftJoin(schema.grantAttachmentArchives, and(
      eq(schema.grants.source, schema.grantAttachmentArchives.source),
      eq(schema.grants.sourceId, schema.grantAttachmentArchives.sourceId),
    )).where(inArray(schema.grants.id, [...grantIds])).groupBy(schema.grants.id);
    const bindings = await loadDeepAnalysisSourceBindings({ db: tx, grantIds });
    const repairFields = policy === MISSING_WORKSPACE_FIELDS_POLICY
      ? await tx.select({ grantId: schema.grantDocumentFields.grantId }).from(schema.grantDocumentFields)
        .where(inArray(schema.grantDocumentFields.grantId, [...grantIds])) : [];
    const repairSurfaces = policy === MISSING_WORKSPACE_FIELDS_POLICY
      ? await tx.select({ grantId: schema.grantApplicationSurfaces.grantId })
        .from(schema.grantApplicationSurfaces)
        .innerJoin(schema.grantAttachmentArchives, and(
          eq(schema.grantAttachmentArchives.source, schema.grantApplicationSurfaces.source),
          eq(schema.grantAttachmentArchives.sourceId, schema.grantApplicationSurfaces.sourceId),
          eq(schema.grantAttachmentArchives.storageKey, schema.grantApplicationSurfaces.sourceAttachment),
        )).where(and(
          inArray(schema.grantApplicationSurfaces.grantId, [...grantIds]),
          eq(schema.grantApplicationSurfaces.type, "file_template"),
          inArray(schema.grantApplicationSurfaces.format, ["hwp", "hwpx"]),
          inArray(schema.grantApplicationSurfaces.extractionStatus, ["preview_ready", "fields_ready"]),
        )) : [];
    if (rows.length !== grantIds.length || new Set(rows.map(row => row.grant.id)).size !== grantIds.length) {
      throw new Error("current inventory 공고/원천이 누락 또는 중복됐습니다.");
    }
    return grantIds.map(grantId => {
      const row = rows.find(row => row.grant.id === grantId)!;
      const grant = row.grant; const binding = bindings.get(grantId);
      if (policy === MISSING_WORKSPACE_FIELDS_POLICY) assertMissingWorkspaceFieldsState({
        fieldCount: repairFields.filter(field => field.grantId === grantId).length,
        editableSurfaceCount: repairSurfaces.filter(surface => surface.grantId === grantId).length,
      });
      if ((grant.source !== "bizinfo" && grant.source !== "kstartup")
        || grant.status !== "open" || grant.servingState !== "visible"
        || classifyNoticePeriod(grant.applyStart, grant.applyEnd, now) !== "eligible"
        || isKStartupRecruitmentClosedPayload(grant.source, row.payload)
        || members.some(member => member.id === grantId) || !binding) {
        throw new Error(`current inventory의 지원 가능 조건이 충족되지 않습니다: ${grantId}`);
      }
      return { grantId, ...binding,
        stratum: stratumIdOf(grant.source, thicknessTierOf(Number(bytes.find(row => row.grantId === grantId)?.maxBytes ?? 0))) };
    });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

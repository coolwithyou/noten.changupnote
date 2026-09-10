import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBindings } from "../deep-analysis/prepareInput";
import { isKStartupRecruitmentClosedPayload } from "../repositories/activeGrantFilter";
import { prepareLabAnalysis } from "./analyze";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import { resolveLabModel } from "./extractor";
import { encodeCanonical, writeAnalysisLaunchArtifact } from "./launch-batch-artifacts";
import { classifyNoticePeriod, kstDayStartUtc } from "./notice-period";
import { findMonorepoRoot } from "./run-store";
import { stratumIdOf, thicknessTierOf } from "./strata";
import {
  CURRENT_INVENTORY_SCHEMA,
  MISSING_WORKSPACE_FIELDS_POLICY,
  buildCurrentInventoryLaunchManifest,
  storeCurrentLaunchInventory,
  type CurrentLaunchInventory,
  type CurrentInventoryPolicy,
} from "./current-inventory-launch";

/** 명시된 최대 100건만 읽는다. 모델 호출과 runtime lease, 서비스 DB/R2 쓰기는 하지 않는다. */
export async function prepareCurrentInventoryLaunch(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
}) {
  return prepareExactInventory(input, "open-visible-current-period-unseen-v1");
}

/** 기존 공고 중 필드가 전혀 없는 exact 대상의 보완 준비. live 권한은 발급하지 않는다. */
export async function prepareMissingWorkspaceFieldsLaunch(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
}) {
  return prepareExactInventory(input, MISSING_WORKSPACE_FIELDS_POLICY);
}

async function prepareExactInventory(input: {
  readonly grantIds: readonly string[];
  readonly concurrency: number;
}, policy: CurrentInventoryPolicy) {
  if (input.grantIds.length < 1 || input.grantIds.length > 100
    || new Set(input.grantIds).size !== input.grantIds.length
    || input.grantIds.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))
    || !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) {
    throw new Error("current inventory는 중복 없는 UUID 1~100건과 concurrency 1~4가 필요합니다.");
  }
  const root = findMonorepoRoot();
  const provenance = await readCurrentDeepRepairExecutionProvenance();
  const history = await readDeepRepairHistoricalGrantIds({ scope: "all" });
  assertCurrentInventoryHistoryEligibility(input.grantIds, history, policy);
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
    seriesId: `current-${policy === MISSING_WORKSPACE_FIELDS_POLICY ? "field-repair-" : ""}${kstDayStartUtc(now).toISOString().slice(0, 10).replaceAll("-", "")}`,
    observedAt: now.toISOString(), model: resolveLabModel(),
    policy,
    historicalGrantIdsSha256: createHash("sha256").update(encodeCanonical(history)).digest("hex"),
    targets: prepared.map((item, sequence) => {
      const row = after.find(row => row.grantId === item.grant.id);
      if (!row) throw new Error("current inventory target이 없습니다.");
      return { sequence, grantId: item.grant.id, stratum: row.stratum,
        inputSha256: item.input.inputSha256,
        attachmentManifestSha256: item.input.attachmentManifestSha256,
        sourceRevisionSha256: row.sourceRevisionSha256 };
    }),
  };
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
    provenance, concurrency: input.concurrency, now: new Date() });
  const stored = await storeCurrentLaunchInventory(root, inventory);
  const launch = await writeAnalysisLaunchArtifact("manifests", manifest, root);
  return { manifest, manifestSha256: launch.sha256, path: launch.path,
    inventorySha256: stored.sha256, inventoryPath: stored.path,
    policy, historicalExcluded: policy === MISSING_WORKSPACE_FIELDS_POLICY ? 0 : history.length,
    modelCalls: 0, serviceWrites: 0,
    liveExecutionAuthorized: false };
}

/** 신규 재고 target 착수 직전에 현행 지원 조건과 봉인 원천을 다시 확인한다. */
export async function verifyCurrentInventoryLaunchTarget(
  inventory: CurrentLaunchInventory,
  grantId: string,
  readEligibility: (ids: readonly string[], policy: CurrentInventoryPolicy) => Promise<readonly { grantId: string; sourceRevisionSha256: string }[]> = readCurrentEligibility,
) {
  const target = inventory.targets.find(item => item.grantId === grantId);
  if (!target) throw new Error("current inventory 밖의 target입니다.");
  const rows = await readEligibility([grantId], inventory.policy);
  if (rows.length !== 1 || rows[0]?.grantId !== grantId
    || rows[0].sourceRevisionSha256 !== target.sourceRevisionSha256) {
    throw new Error("current inventory target 원천이 변경됐습니다.");
  }
}

export function assertCurrentInventoryHistoryEligibility(
  grantIds: readonly string[], history: readonly string[], policy: CurrentInventoryPolicy,
) {
  if (policy === MISSING_WORKSPACE_FIELDS_POLICY) return;
  if (policy !== "open-visible-current-period-unseen-v1") throw new Error("알 수 없는 inventory 정책입니다.");
  const historySet = new Set(history);
  if (grantIds.some(id => historySet.has(id))) throw new Error("current inventory에 과거 이력이 포함됐습니다.");
}

export function assertMissingWorkspaceFieldsState(input: { fieldCount: number; editableSurfaceCount: number }) {
  if (input.fieldCount !== 0 || !Number.isSafeInteger(input.editableSurfaceCount) || input.editableSurfaceCount < 1) {
    throw new Error("누락 필드 보완은 필드 0개이며 보관 HWP/HWPX 양식이 준비된 공고만 허용합니다.");
  }
}

async function readCurrentEligibility(grantIds: readonly string[], policy: CurrentInventoryPolicy) {
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

// 주간 검수 판정 회수 CLI. 감사 파일 CAS, overlay 분리, crash recovery receipt를 보장한다.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type {
  LabAudit,
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
} from "@/features/dev/analysis-lab/contract";
import {
  applyLabAuditJudgments,
  labAuditFilePath,
  readLabAuditFileAt,
  type LabAuditItemUpdate,
} from "./audit-store";
import {
  decideAuditCollectAction,
  latestAuditReceiptSha,
  receiptShaMatches,
  selectCollectableDispatchRowIds,
} from "./collect-core";
import {
  computeAgreementMetrics,
  sha256,
} from "./dispatch-core";
import {
  humanReviewOverlayFilePath,
  mergeHumanReviewOverlay,
  readHumanReviewOverlayFile,
  writeHumanReviewOverlayAtomic,
  type HumanReviewOverlayItem,
} from "./human-review-overlay";
import { analysisLabDir } from "./run-store";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

interface CollectRow {
  id: string;
  noticeId: string;
  sourceItemKey: string;
  collectTarget: string;
  itemKind: string;
  criterionIndex: number | null;
  dimension: string | null;
  assigneeEmail: string;
  overlapGroup: string | null;
  status: string;
  humanVerdict: string | null;
  note: string | null;
  finalVerdict: string | null;
  finalizedBy: string | null;
  finalizedByEmail: string | null;
  revision: number;
  updatedAt: Date;
  collectedAt: Date | null;
  collectReceipt: Record<string, unknown> | null;
}

interface NoticeInfo {
  id: string;
  week: string;
  grantId: string;
  runId: string;
  source: string;
  sourceId: string;
  aiReviewModel: string | null;
  auditFileSha256: string;
}

async function main(): Promise<number> {
  const week = readArg("week")?.trim() || null;
  if (week && !/^\d{4}-W\d{2}$/.test(week)) throw new Error("--week는 YYYY-Www 형식이어야 합니다.");
  const reconcileOnly = process.argv.includes("--reconcile");
  const db = getCunoteDb();
  const notices = await db
    .select({
      id: schema.auditDispatchNotices.id,
      week: schema.auditDispatchBatches.week,
      grantId: schema.auditDispatchNotices.grantId,
      runId: schema.auditDispatchNotices.runId,
      source: schema.auditDispatchNotices.source,
      sourceId: schema.auditDispatchNotices.sourceId,
      aiReviewModel: schema.auditDispatchNotices.aiReviewModel,
      auditFileSha256: schema.auditDispatchNotices.auditFileSha256,
    })
    .from(schema.auditDispatchNotices)
    .innerJoin(
      schema.auditDispatchBatches,
      eq(schema.auditDispatchNotices.batchId, schema.auditDispatchBatches.id),
    );
  const selectedNotices = notices.filter((notice) => !week || notice.week === week);
  if (selectedNotices.length === 0) {
    console.log("[collect] 대상 배치가 없습니다.");
    return 0;
  }

  let collectedFiles = 0;
  let staleFiles = 0;
  let pendingNotices = 0;
  let recoveredRows = 0;
  for (const notice of selectedNotices) {
    const rows = await loadNoticeRows(notice.id);
    if (rows.some((row) => row.status === "pending" || row.status === "conflict")) pendingNotices += 1;
    const collectableIds = selectCollectableDispatchRowIds(rows);
    const uncollected = rows.filter((row) => collectableIds.has(row.id));
    if (uncollected.length === 0) continue;

    for (const target of ["audit_file", "overlay"] as const) {
      const targetRows = uncollected.filter((row) => row.collectTarget === target);
      if (targetRows.length === 0) continue;
      const decisions = collapseDecisions(targetRows);
      if (target === "audit_file") {
        const expectedAuditSha = latestAuditReceiptSha(
          notice.auditFileSha256,
          rows
            .filter((row) => row.collectTarget === "audit_file")
            .map((row) => ({
              collectedAt: row.collectedAt,
              postSha256: row.collectReceipt?.postSha256,
            })),
        );
        const outcome = await collectAuditFile(
          notice,
          decisions,
          targetRows,
          expectedAuditSha,
          reconcileOnly,
        );
        if (outcome === "stale") staleFiles += 1;
        if (outcome === "collected") collectedFiles += 1;
        if (outcome === "recovered") recoveredRows += targetRows.length;
      } else {
        const outcome = await collectOverlayFile(notice, decisions, targetRows, reconcileOnly);
        if (outcome === "collected") collectedFiles += 1;
        if (outcome === "recovered") recoveredRows += targetRows.length;
      }
    }
  }

  const integrity = reconcileOnly ? await verifyReceipts(selectedNotices.map((notice) => notice.id)) : null;
  const reportWeek = week ?? selectedNotices[0]?.week ?? "all";
  const metrics = await writeAgreementReport(reportWeek, selectedNotices.map((notice) => notice.id));
  console.log(
    `[collect] 파일 ${collectedFiles} · 복구 row ${recoveredRows} · stale ${staleFiles} · ` +
    `대기 notice ${pendingNotices}${integrity ? ` · receipt ${integrity.ok}/${integrity.total}` : ""}`,
  );
  for (const metric of metrics) {
    console.log(
      `  - ${metric.itemKind}: 쌍 ${metric.pairCount} · 일치율 ${formatRate(metric.agreementRate)} · ` +
      `κ ${metric.kappa === null ? "N/A" : metric.kappa.toFixed(3)}`,
    );
  }
  return staleFiles > 0 || (integrity && integrity.ok !== integrity.total) ? 2 : 0;
}

async function loadNoticeRows(noticeId: string): Promise<CollectRow[]> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      id: schema.auditDispatchItems.id,
      noticeId: schema.auditDispatchItems.noticeId,
      sourceItemKey: schema.auditDispatchItems.sourceItemKey,
      collectTarget: schema.auditDispatchItems.collectTarget,
      itemKind: schema.auditDispatchItems.itemKind,
      criterionIndex: schema.auditDispatchItems.criterionIndex,
      dimension: schema.auditDispatchItems.dimension,
      assigneeEmail: schema.auditDispatchItems.assigneeEmail,
      overlapGroup: schema.auditDispatchItems.overlapGroup,
      status: schema.auditDispatchItems.status,
      humanVerdict: schema.auditDispatchItems.humanVerdict,
      note: schema.auditDispatchItems.note,
      finalVerdict: schema.auditDispatchItems.finalVerdict,
      finalizedBy: schema.auditDispatchItems.finalizedBy,
      finalizedByEmail: schema.adminUsers.email,
      revision: schema.auditDispatchItems.revision,
      updatedAt: schema.auditDispatchItems.updatedAt,
      collectedAt: schema.auditDispatchItems.collectedAt,
      collectReceipt: schema.auditDispatchItems.collectReceipt,
    })
    .from(schema.auditDispatchItems)
    .leftJoin(
      schema.adminUsers,
      eq(schema.auditDispatchItems.finalizedBy, schema.adminUsers.id),
    )
    .where(eq(schema.auditDispatchItems.noticeId, noticeId));
  return rows;
}

interface CollapsedDecision {
  sourceItemKey: string;
  itemKind: string;
  criterionIndex: number | null;
  dimension: string | null;
  verdict: string;
  note: string | null;
  decidedBy: string;
  decidedAt: string;
  revision: number;
}

function collapseDecisions(rows: CollectRow[]): CollapsedDecision[] {
  const grouped = new Map<string, CollectRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.sourceItemKey) ?? [];
    group.push(row);
    grouped.set(row.sourceItemKey, group);
  }
  const decisions: CollapsedDecision[] = [];
  for (const [sourceItemKey, group] of grouped) {
    const resolved = group.find((row) => row.status === "resolved");
    const verdicts = new Set(group.map((row) => resolved?.finalVerdict ?? row.humanVerdict).filter(Boolean));
    if (verdicts.size !== 1) {
      throw new Error(`${sourceItemKey}: 중복 표본 판정이 충돌 상태 없이 불일치합니다.`);
    }
    const exemplar = resolved ?? group[0]!;
    const verdict = [...verdicts][0];
    if (!verdict) throw new Error(`${sourceItemKey}: 수거할 최종 판정이 없습니다.`);
    decisions.push({
      sourceItemKey,
      itemKind: exemplar.itemKind,
      criterionIndex: exemplar.criterionIndex,
      dimension: exemplar.dimension,
      verdict,
      note: exemplar.note,
      decidedBy: resolved?.finalizedByEmail
        ?? group.map((row) => row.assigneeEmail).sort()[0]!,
      decidedAt: group.map((row) => row.updatedAt.toISOString()).sort().at(-1)!,
      revision: Math.max(...group.map((row) => row.revision)),
    });
  }
  return decisions.sort((left, right) => left.sourceItemKey.localeCompare(right.sourceItemKey));
}

async function collectAuditFile(
  notice: NoticeInfo,
  decisions: CollapsedDecision[],
  rows: CollectRow[],
  expectedAuditSha: string,
  reconcileOnly: boolean,
): Promise<"collected" | "recovered" | "stale" | "skipped"> {
  const model = notice.aiReviewModel;
  if (!model) throw new Error(`${notice.runId}: audit review model이 없습니다.`);
  const path = labAuditFilePath(notice.source, notice.sourceId, notice.runId, model);
  let currentBody: string;
  try {
    currentBody = await readFile(path, "utf8");
  } catch {
    console.error(`[collect] 감사 파일 없음: ${path}`);
    return "stale";
  }
  const currentSha = sha256(currentBody);
  const stored = await readLabAuditFileAt(path);
  if (!stored) {
    console.error(`[collect] 감사 파일 파싱 실패: ${path}`);
    return "stale";
  }
  const updates: LabAuditItemUpdate[] = decisions.map((decision) => ({
    kind: decision.itemKind === "axis" ? "axis" : "criterion",
    ...(decision.criterionIndex !== null ? { criterionIndex: decision.criterionIndex } : {}),
    ...(decision.dimension !== null ? { dimension: decision.dimension as LabAuditItemUpdate["dimension"] } : {}),
    humanVerdict: decision.verdict as LabCriterionVerdict | LabEmptyAxisVerdict,
    note: decision.note,
    decidedBy: decision.decidedBy,
  }));
  const action = decideAuditCollectAction({
    expectedSha256: expectedAuditSha,
    currentSha256: currentSha,
    decisionsAlreadyApplied: auditContainsUpdates(stored, updates),
    reconcileOnly,
  });
  if (action === "recover_receipt") {
    await markCollected(rows, {
      target: "audit_file",
      path,
      mode: "recovered",
      preSha256: expectedAuditSha,
      postSha256: currentSha,
    });
    return "recovered";
  }
  if (action === "stale") {
    console.error(
      `[collect] stale_audit_file ${notice.runId}: expected=${expectedAuditSha} actual=${currentSha}`,
    );
    return "stale";
  }
  if (action === "skip_reconcile") return "skipped";
  const applied = applyLabAuditJudgments(stored, {
    auditorEmail: stored.auditorEmail ?? decisions[0]!.decidedBy,
    items: updates,
    overallNote: stored.overallNote,
    updatedAt: decisions.map((decision) => decision.decidedAt).sort().at(-1)!,
  });
  if (applied.status === "invalid") throw new Error(applied.message);
  const nextBody = `${JSON.stringify(applied.audit, null, 2)}\n`;
  await writeAtomic(path, nextBody);
  const postSha = sha256(nextBody);
  await markCollected(rows, {
    target: "audit_file",
    path,
    mode: "collected",
    preSha256: currentSha,
    postSha256: postSha,
  });
  return "collected";
}

async function collectOverlayFile(
  notice: NoticeInfo,
  decisions: CollapsedDecision[],
  rows: CollectRow[],
  reconcileOnly: boolean,
): Promise<"collected" | "recovered" | "skipped"> {
  const path = humanReviewOverlayFilePath(notice.source, notice.sourceId, notice.runId);
  const current = await readHumanReviewOverlayFile(path);
  const items = decisions.map((decision): HumanReviewOverlayItem => ({
    sourceItemKey: decision.sourceItemKey,
    itemKind: decision.itemKind as HumanReviewOverlayItem["itemKind"],
    ...(decision.criterionIndex !== null ? { criterionIndex: decision.criterionIndex } : {}),
    ...(decision.dimension !== null
      ? { dimension: decision.dimension as NonNullable<HumanReviewOverlayItem["dimension"]> }
      : {}),
    humanVerdict: decision.verdict as HumanReviewOverlayItem["humanVerdict"],
    note: decision.note,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    revision: decision.revision,
  }));
  const alreadyApplied = items.every((item) => {
    const existing = current?.items.find((entry) => entry.sourceItemKey === item.sourceItemKey);
    return existing?.humanVerdict === item.humanVerdict
      && existing.decidedBy === item.decidedBy
      && existing.revision >= item.revision;
  });
  if (alreadyApplied) {
    const body = await readFile(path);
    await markCollected(rows, {
      target: "overlay",
      path,
      mode: "recovered",
      postSha256: sha256(body),
    });
    return "recovered";
  }
  if (reconcileOnly) return "skipped";
  const now = decisions.map((decision) => decision.decidedAt).sort().at(-1)!;
  const merged = mergeHumanReviewOverlay(current, {
    grantId: notice.grantId,
    runId: notice.runId,
    items,
    now,
  });
  await writeHumanReviewOverlayAtomic(path, merged);
  const postSha = sha256(await readFile(path));
  await markCollected(rows, {
    target: "overlay",
    path,
    mode: "collected",
    postSha256: postSha,
  });
  return "collected";
}

function auditContainsUpdates(audit: LabAudit, updates: LabAuditItemUpdate[]): boolean {
  return updates.every((update) => {
    const item = audit.items.find((candidate) =>
      candidate.kind === update.kind
      && (
        update.kind === "criterion"
          ? candidate.criterionIndex === update.criterionIndex
          : candidate.dimension === update.dimension
      ));
    return item?.humanVerdict === update.humanVerdict
      && item.decidedBy === (update.decidedBy ?? audit.auditorEmail);
  });
}

async function markCollected(
  rows: CollectRow[],
  receipt: Record<string, unknown>,
): Promise<void> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return;
  const db = getCunoteDb();
  await db
    .update(schema.auditDispatchItems)
    .set({
      status: "collected",
      collectedAt: new Date(),
      collectReceipt: {
        ...receipt,
        itemIds: ids,
        collectedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(inArray(schema.auditDispatchItems.id, ids));
}

async function verifyReceipts(noticeIds: string[]): Promise<{ ok: number; total: number }> {
  if (noticeIds.length === 0) return { ok: 0, total: 0 };
  const db = getCunoteDb();
  const rows = await db
    .select({
      receipt: schema.auditDispatchItems.collectReceipt,
      collectedAt: schema.auditDispatchItems.collectedAt,
    })
    .from(schema.auditDispatchItems)
    .where(inArray(schema.auditDispatchItems.noticeId, noticeIds));
  const receiptsByPath = new Map<string, Array<{ collectedAt: Date | null; postSha256: unknown }>>();
  for (const row of rows) {
    const path = typeof row.receipt?.path === "string" ? row.receipt.path : null;
    const postSha = typeof row.receipt?.postSha256 === "string" ? row.receipt.postSha256 : null;
    if (!path || !postSha) continue;
    const receipts = receiptsByPath.get(path) ?? [];
    receipts.push({ collectedAt: row.collectedAt, postSha256: postSha });
    receiptsByPath.set(path, receipts);
  }
  let ok = 0;
  for (const [path, receipts] of receiptsByPath) {
    const expected = latestAuditReceiptSha("", receipts);
    try {
      if (receiptShaMatches(expected, sha256(await readFile(path)))) ok += 1;
      else console.error(`[reconcile] receipt SHA 불일치: ${path}`);
    } catch {
      console.error(`[reconcile] receipt 파일 없음: ${path}`);
    }
  }
  return { ok, total: receiptsByPath.size };
}

async function writeAgreementReport(week: string, noticeIds: string[]) {
  if (noticeIds.length === 0) return [];
  const db = getCunoteDb();
  const rows = await db
    .select({
      itemKind: schema.auditDispatchItems.itemKind,
      overlapGroup: schema.auditDispatchItems.overlapGroup,
      humanVerdict: schema.auditDispatchItems.humanVerdict,
      raterKey: schema.auditDispatchItems.assigneeEmail,
    })
    .from(schema.auditDispatchItems)
    .where(inArray(schema.auditDispatchItems.noticeId, noticeIds));
  const metrics = computeAgreementMetrics(rows);
  const path = join(dirname(analysisLabDir()), "ops", `review-metrics-${week}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schema: "human-review-agreement-v1",
    week,
    generatedAt: new Date().toISOString(),
    clusterNote: "중복 표본은 공고 단위로 배분되어 항목 간 독립 표본이 아닙니다.",
    metrics,
  }, null, 2)}\n`, "utf8");
  return metrics;
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, path);
}

function formatRate(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function closeDb(): Promise<void> {
  const { closeCunoteDb } = await import("../db/client");
  await closeCunoteDb();
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[collect] 실패:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });

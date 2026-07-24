import type { AdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import type { TransactionSql } from "postgres";
import {
  HUMAN_REVIEW_VERDICTS,
  humanReviewVerdictRequiresNote,
  isHumanReviewVerdictForItemKind,
  type HumanReviewVerdict,
} from "@cunote/contracts";

export const REVIEW_VERDICTS = HUMAN_REVIEW_VERDICTS;
export type ReviewVerdict = HumanReviewVerdict;

export class DispatchReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DispatchReviewError";
  }
}

interface QueueRow {
  notice_id: string;
  week: string;
  title: string;
  source: string;
  source_id: string;
  assignees: ReviewQueueAssignee[];
  item_count: number;
  decided_count: number;
  conflict_count: number;
  updated_at: string | null;
}

export interface ReviewQueueAssignee {
  id: string;
  email: string;
  name: string | null;
}

export interface ReviewQueueItem {
  noticeId: string;
  week: string;
  title: string;
  source: string;
  sourceId: string;
  assignees: ReviewQueueAssignee[];
  itemCount: number;
  decidedCount: number;
  conflictCount: number;
  progress: number;
  updatedAt: string | null;
}

export async function listReviewQueue(
  session: AdminSession,
  options: { week?: string | null; limit?: number } = {},
): Promise<{ week: string | null; items: ReviewQueueItem[] }> {
  const sql = getAdminSql();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const week = options.week?.trim() || null;
  const assignmentFilter = session.user.role === "reviewer"
    ? sql`AND i.assignee_id = ${session.user.id}::uuid`
    : sql``;
  const weekFilter = week ? sql`AND b.week = ${week}` : sql``;
  const rows = await sql<QueueRow[]>`
    SELECT
      n.id AS notice_id,
      b.week,
      n.title,
      n.source,
      n.source_id,
      jsonb_agg(
        DISTINCT jsonb_build_object(
          'id', i.assignee_id,
          'email', i.assignee_email,
          'name', assignee.name
        )
      ) AS assignees,
      count(i.id)::int AS item_count,
      count(i.id) FILTER (WHERE i.status IN ('decided', 'resolved', 'collected'))::int AS decided_count,
      count(i.id) FILTER (WHERE i.status = 'conflict')::int AS conflict_count,
      max(i.updated_at)::text AS updated_at
    FROM audit_dispatch_notices n
    JOIN audit_dispatch_batches b ON b.id = n.batch_id
    JOIN audit_dispatch_items i ON i.notice_id = n.id
    LEFT JOIN admin_users assignee ON assignee.id = i.assignee_id
    WHERE true
      ${assignmentFilter}
      ${weekFilter}
    GROUP BY n.id, b.week, n.title, n.source, n.source_id
    ORDER BY
      (count(i.id) FILTER (WHERE i.status = 'pending') > 0) DESC,
      max(i.updated_at) ASC NULLS FIRST,
      n.id
    LIMIT ${limit}
  `;
  return {
    week: week ?? rows[0]?.week ?? null,
    items: rows.map((row) => ({
      noticeId: row.notice_id,
      week: row.week,
      title: row.title,
      source: row.source,
      sourceId: row.source_id,
      assignees: [...row.assignees].sort((left, right) =>
        (left.name ?? left.email).localeCompare(right.name ?? right.email, "ko-KR"),
      ),
      itemCount: row.item_count,
      decidedCount: row.decided_count,
      conflictCount: row.conflict_count,
      progress: row.item_count === 0 ? 0 : Math.round((row.decided_count / row.item_count) * 100),
      updatedAt: row.updated_at,
    })),
  };
}

interface NoticeRow {
  id: string;
  allowed: boolean;
  week: string;
  title: string;
  source: string;
  source_id: string;
  source_url: string | null;
  run_id: string;
  input_text: string | null;
  analysis_markdown: string | null;
}

interface AttachmentRow {
  id: string;
  filename: string;
  source_uri: string;
  content_type: string | null;
  bytes: number | null;
}

interface ItemRow {
  id: string;
  source_item_key: string;
  collect_target: "audit_file" | "overlay";
  item_kind: "criterion" | "axis" | "question_check";
  criterion_index: number | null;
  dimension: string | null;
  payload: Record<string, unknown>;
  assignee_id: string;
  assignee_email: string;
  blind: boolean;
  status: string;
  human_verdict: string | null;
  note: string | null;
  final_verdict: string | null;
  revision: number;
  updated_at: string;
}

export interface ReviewNoticeItem {
  id: string;
  sourceItemKey: string;
  collectTarget: "audit_file" | "overlay";
  itemKind: "criterion" | "axis" | "question_check";
  criterionIndex: number | null;
  dimension: string | null;
  payload: Record<string, unknown>;
  assigneeId: string;
  assigneeEmail: string;
  blind: boolean;
  status: string;
  humanVerdict: string | null;
  note: string | null;
  finalVerdict: string | null;
  revision: number;
  updatedAt: string;
}

export interface ReviewNoticeDetail {
  id: string;
  week: string;
  title: string;
  source: string;
  sourceId: string;
  sourceUrl: string | null;
  runId: string;
  inputText: string;
  analysisMarkdown: string;
  attachments: ReviewNoticeAttachment[];
  items: ReviewNoticeItem[];
}

export interface ReviewNoticeAttachment {
  id: string;
  filename: string;
  format: "hwp" | "hwpx";
  bytes: number | null;
}

export interface ReviewAttachmentSource extends ReviewNoticeAttachment {
  source: string;
  sourceUri: string;
  contentType: string | null;
}

const MAX_DOCUMENT_CHARS = 240_000;
const MAX_PAYLOAD_CHARS = 80_000;
const MAX_TOTAL_PAYLOAD_CHARS = 240_000;

export async function getReviewNotice(
  session: AdminSession,
  noticeId: string,
): Promise<ReviewNoticeDetail> {
  assertUuid(noticeId, "noticeId");
  const sql = getAdminSql();
  const itemFilter = session.user.role === "reviewer"
    ? sql`AND assignee_id = ${session.user.id}::uuid`
    : sql``;
  const accessProjection = session.user.role === "reviewer"
    ? sql`EXISTS (
        SELECT 1
        FROM audit_dispatch_items access_item
        WHERE access_item.notice_id = n.id
          AND access_item.assignee_id = ${session.user.id}::uuid
      ) AS allowed`
    : sql`true AS allowed`;
  const [rows, itemRows, attachmentRows] = await Promise.all([
    sql<NoticeRow[]>`
      SELECT
        n.id, ${accessProjection}, b.week, n.title, n.source, n.source_id, n.run_id,
        n.input_text, n.analysis_markdown, g.url AS source_url
      FROM audit_dispatch_notices n
      JOIN audit_dispatch_batches b ON b.id = n.batch_id
      LEFT JOIN grants g ON g.id = n.grant_id
      WHERE n.id = ${noticeId}::uuid
      LIMIT 1
    `,
    sql<ItemRow[]>`
      SELECT
        id, source_item_key, collect_target, item_kind, criterion_index, dimension,
        payload, assignee_id, assignee_email, blind, status, human_verdict, note,
        final_verdict, revision, updated_at::text
      FROM audit_dispatch_items
      WHERE notice_id = ${noticeId}::uuid
        ${itemFilter}
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'conflict' THEN 1 ELSE 2 END,
        criterion_index NULLS LAST,
        dimension NULLS LAST,
        id
    `,
    sql<AttachmentRow[]>`
      SELECT a.id, a.filename, a.source_uri, a.content_type, a.bytes
      FROM grant_attachment_archives a
      JOIN audit_dispatch_notices n
        ON n.source = a.source::text
        AND n.source_id = a.source_id
      WHERE n.id = ${noticeId}::uuid
        AND a.filename ~* '\\.hwpx?$'
        AND nullif(a.source_uri, '') IS NOT NULL
      ORDER BY a.filename, a.id
      LIMIT 20
    `,
  ]);
  const notice = rows[0];
  if (!notice) throw new DispatchReviewError("review_notice_not_found", "검수 공고를 찾을 수 없습니다.", 404);
  if (!notice.allowed) {
    throw new DispatchReviewError(
      "review_notice_forbidden",
      "본인에게 배정된 검수 공고만 열 수 있습니다.",
      403,
    );
  }

  let remainingPayloadChars = MAX_TOTAL_PAYLOAD_CHARS;
  return {
    id: notice.id,
    week: notice.week,
    title: notice.title,
    source: notice.source,
    sourceId: notice.source_id,
    sourceUrl: notice.source_url,
    runId: notice.run_id,
    inputText: (notice.input_text ?? "").slice(0, MAX_DOCUMENT_CHARS),
    analysisMarkdown: (notice.analysis_markdown ?? "").slice(0, MAX_DOCUMENT_CHARS),
    attachments: attachmentRows.map((row) => ({
      id: row.id,
      filename: row.filename,
      format: attachmentFormat(row.filename),
      bytes: row.bytes,
    })),
    items: itemRows.map((row) => {
      let payload = sanitizeReviewPayload(row.payload, row.blind);
      const payloadChars = JSON.stringify(payload).length;
      if (payloadChars > remainingPayloadChars) {
        payload = {
          summary: "notice_payload_budget_exhausted",
          sourceItemKey: row.source_item_key,
        };
      } else {
        remainingPayloadChars -= payloadChars;
      }
      return {
        id: row.id,
        sourceItemKey: row.source_item_key,
        collectTarget: row.collect_target,
        itemKind: row.item_kind,
        criterionIndex: row.criterion_index,
        dimension: row.dimension,
        payload,
        assigneeId: row.assignee_id,
        assigneeEmail: row.assignee_email,
        blind: row.blind,
        status: row.status,
        humanVerdict: row.human_verdict,
        note: row.note,
        finalVerdict: row.final_verdict,
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    }),
  };
}

export async function getReviewAttachmentSource(
  session: AdminSession,
  noticeId: string,
  attachmentId: string,
): Promise<ReviewAttachmentSource> {
  assertUuid(noticeId, "noticeId");
  assertUuid(attachmentId, "attachmentId");
  const sql = getAdminSql();
  await assertNoticeAccess(sql, session, noticeId);
  const rows = await sql<Array<AttachmentRow & { source: string }>>`
    SELECT a.id, a.source::text AS source, a.filename, a.source_uri, a.content_type, a.bytes
    FROM grant_attachment_archives a
    JOIN audit_dispatch_notices n
      ON n.source = a.source::text
      AND n.source_id = a.source_id
    WHERE n.id = ${noticeId}::uuid
      AND a.id = ${attachmentId}::uuid
      AND a.filename ~* '\\.hwpx?$'
      AND nullif(a.source_uri, '') IS NOT NULL
    LIMIT 1
  `;
  const attachment = rows[0];
  if (!attachment) {
    throw new DispatchReviewError(
      "review_attachment_not_found",
      "검수할 HWP/HWPX 첨부를 찾을 수 없습니다.",
      404,
    );
  }
  return {
    id: attachment.id,
    source: attachment.source,
    filename: attachment.filename,
    format: attachmentFormat(attachment.filename),
    sourceUri: attachment.source_uri,
    contentType: attachment.content_type,
    bytes: attachment.bytes,
  };
}

export async function saveReviewVerdicts(
  session: AdminSession,
  noticeId: string,
  input: Array<{
    itemId: string;
    humanVerdict: ReviewVerdict;
    note: string | null;
    revision: number;
  }>,
): Promise<{ updated: Array<{ itemId: string; revision: number; status: string }> }> {
  assertUuid(noticeId, "noticeId");
  if (input.length === 0 || input.length > 100) {
    throw new DispatchReviewError("invalid_review_items", "저장할 판정 항목을 확인해주세요.", 400, "items");
  }
  for (const item of input) validateVerdictInput(item);

  const sql = getAdminSql();
  return sql.begin(async (tx) => {
    const updated: Array<{ itemId: string; revision: number; status: string }> = [];
    for (const item of input) {
      const owned = await tx<{ item_kind: "criterion" | "axis" | "question_check" }[]>`
        SELECT item_kind
        FROM audit_dispatch_items
        WHERE id = ${item.itemId}::uuid
          AND notice_id = ${noticeId}::uuid
          AND assignee_id = ${session.user.id}::uuid
        FOR UPDATE
      `;
      const itemKind = owned[0]?.item_kind;
      if (!itemKind) {
        throw new DispatchReviewError("review_item_not_found", "배정된 검수 항목을 찾을 수 없습니다.", 404, item.itemId);
      }
      if (!isHumanReviewVerdictForItemKind(itemKind, item.humanVerdict)) {
        throw new DispatchReviewError(
          "invalid_human_verdict",
          itemKind === "axis"
            ? "빈 축 판정은 없음 확인·누락 있음 중 하나여야 합니다."
            : "criterion 판정 어휘를 확인해주세요.",
          400,
          item.itemId,
        );
      }
      const rows = await tx<{ id: string; revision: number; status: string; overlap_group: string | null }[]>`
        UPDATE audit_dispatch_items
        SET
          human_verdict = ${item.humanVerdict},
          note = ${normalizeNote(item.note)},
          status = 'decided',
          decided_at = now(),
          revision = revision + 1,
          updated_at = now()
        WHERE id = ${item.itemId}::uuid
          AND notice_id = ${noticeId}::uuid
          AND assignee_id = ${session.user.id}::uuid
          AND revision = ${item.revision}
          AND status IN ('pending', 'decided')
        RETURNING id, revision, status, overlap_group
      `;
      const row = rows[0];
      if (!row) {
        throw new DispatchReviewError(
          "review_revision_conflict",
          "다른 세션에서 판정이 갱신됐습니다. 새로고침 후 다시 저장해주세요.",
          409,
          item.itemId,
        );
      }
      if (row.overlap_group) await reconcileOverlapStatus(tx, row.overlap_group);
      updated.push({ itemId: row.id, revision: row.revision, status: row.status });
    }
    return { updated };
  });
}

export interface AdjudicationItem {
  overlapGroup: string;
  noticeId: string;
  noticeTitle: string;
  itemKind: string;
  dimension: string | null;
  sourceItemKey: string;
  decisions: Array<{
    itemId: string;
    assigneeEmail: string;
    humanVerdict: string;
    note: string | null;
  }>;
}

export async function listAdjudicationItems(): Promise<AdjudicationItem[]> {
  const sql = getAdminSql();
  const rows = await sql<Array<{
    overlap_group: string;
    notice_id: string;
    title: string;
    item_kind: string;
    dimension: string | null;
    source_item_key: string;
    item_id: string;
    assignee_email: string;
    human_verdict: string;
    note: string | null;
  }>>`
    SELECT
      i.overlap_group, i.notice_id, n.title, i.item_kind, i.dimension,
      i.source_item_key, i.id AS item_id, i.assignee_email, i.human_verdict, i.note
    FROM audit_dispatch_items i
    JOIN audit_dispatch_notices n ON n.id = i.notice_id
    WHERE i.status = 'conflict'
      AND i.overlap_group IS NOT NULL
    ORDER BY i.updated_at, i.overlap_group, i.assignee_email
  `;
  const grouped = new Map<string, AdjudicationItem>();
  for (const row of rows) {
    const item = grouped.get(row.overlap_group) ?? {
      overlapGroup: row.overlap_group,
      noticeId: row.notice_id,
      noticeTitle: row.title,
      itemKind: row.item_kind,
      dimension: row.dimension,
      sourceItemKey: row.source_item_key,
      decisions: [],
    };
    item.decisions.push({
      itemId: row.item_id,
      assigneeEmail: row.assignee_email,
      humanVerdict: row.human_verdict,
      note: row.note,
    });
    grouped.set(row.overlap_group, item);
  }
  return [...grouped.values()];
}

export async function adjudicateConflict(
  session: AdminSession,
  itemId: string,
  finalVerdict: ReviewVerdict,
  note: string | null,
): Promise<{ overlapGroup: string; resolved: number }> {
  assertUuid(itemId, "itemId");
  if (!REVIEW_VERDICTS.includes(finalVerdict)) {
    throw new DispatchReviewError("invalid_final_verdict", "최종 판정 어휘를 확인해주세요.", 400, "finalVerdict");
  }
  if (!normalizeNote(note)) {
    throw new DispatchReviewError("adjudication_note_required", "3심 최종 판정 사유가 필요합니다.", 400, "note");
  }
  const sql = getAdminSql();
  return sql.begin(async (tx) => {
    const groups = await tx<{ overlap_group: string; item_kind: "criterion" | "axis" | "question_check" }[]>`
      SELECT overlap_group, item_kind
      FROM audit_dispatch_items
      WHERE id = ${itemId}::uuid AND status = 'conflict'
      FOR UPDATE
    `;
    const overlapGroup = groups[0]?.overlap_group;
    if (!overlapGroup) {
      throw new DispatchReviewError("conflict_not_found", "3심 대상 충돌 항목을 찾을 수 없습니다.", 404);
    }
    if (!isHumanReviewVerdictForItemKind(groups[0]!.item_kind, finalVerdict)) {
      throw new DispatchReviewError("invalid_final_verdict", "항목 종류에 맞는 최종 판정이 아닙니다.", 400, "finalVerdict");
    }
    const resolved = await tx<{ id: string }[]>`
      UPDATE audit_dispatch_items
      SET
        final_verdict = ${finalVerdict},
        finalized_by = ${session.user.id}::uuid,
        note = concat_ws(E'\n\n', nullif(note, ''), ${normalizeNote(note)}),
        status = 'resolved',
        resolved_at = now(),
        revision = revision + 1,
        updated_at = now()
      WHERE overlap_group = ${overlapGroup}::uuid
        AND status = 'conflict'
      RETURNING id
    `;
    return { overlapGroup, resolved: resolved.length };
  });
}

function validateVerdictInput(input: {
  itemId: string;
  humanVerdict: ReviewVerdict;
  note: string | null;
  revision: number;
}): void {
  assertUuid(input.itemId, "itemId");
  if (!REVIEW_VERDICTS.includes(input.humanVerdict)) {
    throw new DispatchReviewError("invalid_human_verdict", "판정 어휘를 확인해주세요.", 400, input.itemId);
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new DispatchReviewError("invalid_revision", "판정 revision을 확인해주세요.", 400, input.itemId);
  }
  if (humanReviewVerdictRequiresNote(input.humanVerdict) && !normalizeNote(input.note)) {
    throw new DispatchReviewError(
      "review_note_required",
      "수정 필요·오류·판단 불가·누락 판정에는 사유가 필요합니다.",
      400,
      input.itemId,
    );
  }
}

async function reconcileOverlapStatus(
  tx: TransactionSql,
  overlapGroup: string,
): Promise<void> {
  const rows = await tx<{ id: string; human_verdict: string | null; status: string }[]>`
    SELECT id, human_verdict, status
    FROM audit_dispatch_items
    WHERE overlap_group = ${overlapGroup}::uuid
    FOR UPDATE
  `;
  const nextStatus = overlapStatusForVerdicts(rows.map((row) => row.human_verdict));
  if (nextStatus === "pending") return;
  await tx`
    UPDATE audit_dispatch_items
    SET status = ${nextStatus}, updated_at = now()
    WHERE overlap_group = ${overlapGroup}::uuid
      AND status <> 'collected'
  `;
}

export function overlapStatusForVerdicts(
  verdicts: Array<string | null>,
): "pending" | "decided" | "conflict" {
  if (verdicts.length < 2 || verdicts.some((verdict) => verdict === null)) return "pending";
  return new Set(verdicts).size > 1 ? "conflict" : "decided";
}

export function sanitizeReviewPayload(
  payload: Record<string, unknown>,
  blind: boolean,
): Record<string, unknown> {
  const serialized = JSON.stringify(payload);
  const bounded = serialized.length > MAX_PAYLOAD_CHARS
    ? { summary: "payload_too_large", sourceItemKey: stringValue(payload.sourceItemKey) }
    : payload;
  return blind ? redactBlindValue(bounded) as Record<string, unknown> : bounded;
}

function redactBlindValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBlindValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const tokens = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
    if (tokens.some((token) =>
      ["ai", "audit", "review", "reviewer", "verdict", "assignee", "auditor", "other"].includes(token))) continue;
    result[key] = redactBlindValue(entry);
  }
  return result;
}

function normalizeNote(value: string | null | undefined): string | null {
  const note = value?.trim() ?? "";
  return note ? note.slice(0, 4_000) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function assertNoticeAccess(
  sql: ReturnType<typeof getAdminSql>,
  session: AdminSession,
  noticeId: string,
): Promise<void> {
  const notices = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM audit_dispatch_notices
      WHERE id = ${noticeId}::uuid
    ) AS exists
  `;
  if (!notices[0]?.exists) {
    throw new DispatchReviewError("review_notice_not_found", "검수 공고를 찾을 수 없습니다.", 404);
  }
  if (session.user.role !== "reviewer") return;
  const assignments = await sql<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM audit_dispatch_items
      WHERE notice_id = ${noticeId}::uuid
        AND assignee_id = ${session.user.id}::uuid
    ) AS allowed
  `;
  if (!assignments[0]?.allowed) {
    throw new DispatchReviewError(
      "review_notice_forbidden",
      "본인에게 배정된 검수 공고만 열 수 있습니다.",
      403,
    );
  }
}

function attachmentFormat(filename: string): "hwp" | "hwpx" {
  return filename.toLowerCase().endsWith(".hwpx") ? "hwpx" : "hwp";
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DispatchReviewError("invalid_uuid", "요청 식별자를 확인해주세요.", 400, field);
  }
}

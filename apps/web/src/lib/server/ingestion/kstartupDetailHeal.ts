// K-Startup 상세 치유 공용 로직. 한 건의 공고에 대해 상세 페이지를 fetch 하고
// grant_raw.payload.detail 병합 → attachments 갱신 → raw_hash 재계산 → grant_raw update 를 수행한다.
//
// backfill-kstartup-details.ts(CLI 백필)와 /api/cron/kstartup-details(라우트 B)가
// 이 구현을 공유해 동작을 일치시킨다. rate limit(요청 간 sleep)은 호출부 루프의 책임이다.
//
// robots.txt 준수: 상세 페이지(/web/contents/*)만 GET 한다. 첨부 본문(/afile/*)은
// 절대 다운로드하지 않고 파일명 + 다운로드 URL 메타데이터만 저장한다.
import { and, eq } from "drizzle-orm";
import type { GrantRaw } from "@cunote/contracts";
import {
  deriveKStartupAuthoringMode,
  type KStartupAnnouncement,
  type KStartupDetailContent,
} from "@cunote/core";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { hashGrantRawPayload } from "./grantRawHash";
import { attachmentsFromDetail, fetchKStartupDetailWithRetry } from "./kstartupDetailFetch";
import { preserveArchivedKStartupAttachmentMetadata } from "./kstartupAttachmentSelection";

export type HealDetailStatus = "updated" | "observed" | "dry_run" | "no_raw" | "fetch_failed";

export interface HealDetailResult {
  ok: boolean;
  status: HealDetailStatus;
  /** fetch 성공 시(즉 fetch_failed 가 아닌 모든 경우) 채워진다. */
  detail?: KStartupDetailContent;
  attachments?: NonNullable<GrantRaw["attachments"]>;
  error?: string;
}

/**
 * 한 건의 K-Startup 공고 상세를 치유한다.
 * - write=false: fetch·파싱만 하고 DB 는 건드리지 않는다(dry_run).
 * - write=true: grant_raw 를 조회해 payload.detail 병합 + attachments + raw_hash 갱신.
 *   대응 grant_raw 행이 없으면 no_raw(미기록).
 * - fetch 실패는 throw 하지 않고 result 로 돌려준다(개별 실패가 배치를 멈추지 않도록).
 */
export async function healKStartupGrantDetail(
  db: CunoteDb,
  input: { sourceId: string; url: string; write: boolean },
): Promise<HealDetailResult> {
  const outcome = await fetchKStartupDetailWithRetry(input.url);
  if (!outcome.ok) {
    return { ok: false, status: "fetch_failed", error: outcome.error };
  }

  const detail = outcome.content;
  const attachments = attachmentsFromDetail(detail);

  if (!input.write) {
    return { ok: true, status: "dry_run", detail, attachments };
  }

  const existing = await readGrantRawPayload(db, input.sourceId);
  if (!existing) {
    return { ok: false, status: "no_raw", detail, attachments };
  }

  const nextPayload: Record<string, unknown> = { ...existing.payload, detail };
  const nextAttachments = preserveArchivedKStartupAttachmentMetadata(attachments, existing.attachments);
  const observedAt = new Date(detail.fetched_at);
  if (!Number.isFinite(observedAt.getTime())) {
    return { ok: false, status: "fetch_failed", error: "invalid detail fetched_at" };
  }

  // 정기 재수집의 fetched_at만 달라진 경우 raw payload와 rawHash를 다시 쓰지 않는다.
  // rawHash는 source revision의 일부이므로 관측 시각 갱신을 공고 내용 변경으로 만들면
  // 동일한 분석 입력·첨부가 매주 stale 처리된다. collectedAt만 최신 관측 시각으로 이동해
  // cron freshness는 유지하고, 실제 상세 내용/첨부가 바뀔 때만 revision을 전진시킨다.
  if (isKStartupDetailMateriallyEqual({
    previousDetail: existing.payload.detail,
    currentDetail: detail,
    previousAttachments: existing.attachments,
    currentAttachments: nextAttachments,
  })) {
    await db
      .update(schema.grantRaw)
      .set({ collectedAt: observedAt })
      .where(and(
        eq(schema.grantRaw.source, "kstartup"),
        eq(schema.grantRaw.sourceId, input.sourceId),
      ));
    return { ok: true, status: "observed", detail, attachments: nextAttachments };
  }

  await db
    .update(schema.grantRaw)
    .set({
      payload: nextPayload,
      attachments: nextAttachments as unknown as Array<Record<string, unknown>>,
      rawHash: hashGrantRawPayload(nextPayload),
      collectedAt: observedAt,
    })
    .where(and(
      eq(schema.grantRaw.source, "kstartup"),
      eq(schema.grantRaw.sourceId, input.sourceId),
    ));

  // detail 이 새로 붙었으니 grants 의 작성 방식 판정도 함께 갱신한다
  // (raw 만 고치면 f_authoring_mode 가 unknown 으로 남는다).
  const authoringMode = deriveKStartupAuthoringMode(nextPayload as unknown as KStartupAnnouncement);
  await db
    .update(schema.grants)
    .set({ fAuthoringMode: authoringMode })
    .where(and(
      eq(schema.grants.source, "kstartup"),
      eq(schema.grants.sourceId, input.sourceId),
    ));

  return { ok: true, status: "updated", detail, attachments: nextAttachments };
}

export function isKStartupDetailMateriallyEqual(input: {
  previousDetail: unknown;
  currentDetail: KStartupDetailContent;
  previousAttachments: GrantRaw["attachments"] | null | undefined;
  currentAttachments: GrantRaw["attachments"] | null | undefined;
}): boolean {
  const previous = detailMaterial(input.previousDetail);
  if (!previous) return false;
  return hashGrantRawPayload({
    detail: previous,
    attachments: input.previousAttachments ?? [],
  }) === hashGrantRawPayload({
    detail: detailMaterial(input.currentDetail),
    attachments: input.currentAttachments ?? [],
  });
}

function detailMaterial(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { fetched_at: _observedAt, ...material } = value as Record<string, unknown>;
  return material;
}

async function readGrantRawPayload(
  db: CunoteDb,
  sourceId: string,
): Promise<{
  payload: Record<string, unknown>;
  attachments: NonNullable<GrantRaw["attachments"]> | null;
} | null> {
  const [row] = await db
    .select({ payload: schema.grantRaw.payload, attachments: schema.grantRaw.attachments })
    .from(schema.grantRaw)
    .where(and(eq(schema.grantRaw.source, "kstartup"), eq(schema.grantRaw.sourceId, sourceId)))
    .limit(1);
  return row ? {
    payload: row.payload,
    attachments: row.attachments as NonNullable<GrantRaw["attachments"]> | null,
  } : null;
}

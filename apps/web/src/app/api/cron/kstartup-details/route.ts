// Vercel Cron: K-Startup 상세 치유(래퍼). 모집 중 공고 중 grant_raw.payload.detail 이 없는 것을 우선,
// 그다음 detail.fetched_at 이 staleDays 보다 오래된 것을 상세 재수집한다. 라우트 A 가 예산 초과로 남긴
// 공고(skippedBudget)를 여기서 메꾼다. 치유 로직은 backfill CLI 와 공용(kstartupDetailHeal).
//
// robots.txt 준수: 상세 페이지(/web/contents/*)만 GET, 첨부 본문은 다운로드하지 않는다.
import { and, eq, sql } from "drizzle-orm";
import type { KStartupAnnouncement } from "@cunote/core";
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  resolveKStartupDetailUrl,
  sleep,
  KSTARTUP_DETAIL_REQUEST_DELAY_MS,
} from "@/lib/server/ingestion/kstartupDetailFetch";
import { healKStartupGrantDetail } from "@/lib/server/ingestion/kstartupDetailHeal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 서식성(작성용) 첨부 판정: hwp/hwpx/doc/docx. */
const FORM_EXTENSIONS = /\.(hwp|hwpx|docx?)$/i;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const staleDays = boundedIntParam(params.get("staleDays"), 7, 1, 365);
  const limit = boundedIntParam(params.get("limit"), 120, 1, 200);

  const startedAt = Date.now();
  const db = getCunoteDb();

  try {
    const targets = await selectHealTargets(db, staleDays, limit);

    let processed = 0;
    let succeeded = 0;
    let updated = 0;
    let failed = 0;
    let skippedNoUrl = 0;
    let skippedNoRaw = 0;
    let withFormFileCount = 0;
    let first = true;

    for (const target of targets) {
      processed += 1;
      if (!target.url) {
        skippedNoUrl += 1;
        continue;
      }

      if (!first) await sleep(KSTARTUP_DETAIL_REQUEST_DELAY_MS);
      first = false;

      const result = await healKStartupGrantDetail(db, {
        sourceId: target.sourceId,
        url: target.url,
        write: true,
      });

      if (result.attachments) {
        succeeded += 1;
        if (result.attachments.some((attachment) => FORM_EXTENSIONS.test(attachment.filename))) {
          withFormFileCount += 1;
        }
      }

      if (!result.ok) {
        if (result.status === "no_raw") skippedNoRaw += 1;
        else failed += 1;
      } else if (result.status === "updated") {
        updated += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      params: { staleDays, limit },
      summary: {
        targeted: targets.length,
        processed,
        succeeded,
        updated,
        failed,
        skippedNoUrl,
        skippedNoRaw,
        withFormFileCount,
      },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "detail_heal_failed",
          message: error instanceof Error ? error.message : "상세 치유에 실패했습니다.",
        },
        params: { staleDays, limit },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

interface HealTarget {
  sourceId: string;
  url: string | null;
}

/**
 * 치유 대상 선정: 모집 중(status='open') K-Startup 공고 중 대응 grant_raw 가 존재하고
 *   1) payload.detail 이 없는 것(우선), 그다음
 *   2) detail.fetched_at 이 staleDays 보다 오래된 것.
 * fetched_at 은 ISO-8601(UTC) 문자열이라 사전식 비교 == 시간순 비교.
 */
async function selectHealTargets(
  db: ReturnType<typeof getCunoteDb>,
  staleDays: number,
  limit: number,
): Promise<HealTarget[]> {
  const staleCutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  const detailJson = sql`${schema.grantRaw.payload} -> 'detail'`;
  const fetchedAt = sql`${schema.grantRaw.payload} -> 'detail' ->> 'fetched_at'`;

  const rows = await db
    .select({
      sourceId: schema.grants.sourceId,
      url: schema.grants.url,
      payload: schema.grantRaw.payload,
    })
    .from(schema.grants)
    .innerJoin(
      schema.grantRaw,
      and(
        eq(schema.grantRaw.source, schema.grants.source),
        eq(schema.grantRaw.sourceId, schema.grants.sourceId),
      ),
    )
    .where(and(
      eq(schema.grants.source, "kstartup"),
      eq(schema.grants.status, "open"),
      sql`(${detailJson} IS NULL OR ${fetchedAt} < ${staleCutoff})`,
    ))
    .orderBy(sql`(${detailJson} IS NULL) DESC, ${fetchedAt} ASC NULLS FIRST`)
    .limit(limit);

  return rows.map((row) => {
    const payload = row.payload as unknown as KStartupAnnouncement | null;
    const url = textOrNull(row.url) ?? (payload ? resolveKStartupDetailUrl(payload) : null);
    return { sourceId: row.sourceId, url };
  });
}

function textOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 쿼리 파라미터를 정수로 파싱한다. 비어있으면 fallback, 범위를 벗어나면 clamp. */
function boundedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

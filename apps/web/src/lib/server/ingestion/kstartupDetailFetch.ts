// K-Startup 상세 페이지 수집 공용 헬퍼.
//
// robots.txt 준수: 상세 페이지(/web/contents/*)만 GET 한다. 첨부 본문(/afile/*)은
// 절대 다운로드하지 않고 파일명 + 다운로드 URL 메타데이터만 파싱해 저장한다.

import type { GrantRaw } from "@cunote/contracts";
import {
  fetchKStartupDetail,
  type KStartupAnnouncement,
  type KStartupDetailContent,
} from "@cunote/core";

/** 요청 간 지연(ms). 순차 처리로 원본 서버 부하를 낮춘다. */
export const KSTARTUP_DETAIL_REQUEST_DELAY_MS = 350;
/** 단일 요청 타임아웃(ms). */
export const KSTARTUP_DETAIL_TIMEOUT_MS = 15_000;
/** 실패 시 재시도 횟수(최초 1회 + 재시도 1회). */
export const KSTARTUP_DETAIL_RETRIES = 1;

export interface DetailFetchOk {
  ok: true;
  content: KStartupDetailContent;
}
export interface DetailFetchError {
  ok: false;
  error: string;
}
export type DetailFetchOutcome = DetailFetchOk | DetailFetchError;

export interface DetailFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  fetchedAt?: string | Date;
}

/**
 * 상세 페이지를 GET·파싱한다. 실패 시 재시도 후 result 타입으로 오류를 돌려준다
 * (throw 하지 않는다 — 개별 공고 실패가 전체 배치를 멈추지 않도록).
 */
export async function fetchKStartupDetailWithRetry(
  url: string,
  options: DetailFetchOptions = {},
): Promise<DetailFetchOutcome> {
  const retries = options.retries ?? KSTARTUP_DETAIL_RETRIES;
  const timeoutMs = options.timeoutMs ?? KSTARTUP_DETAIL_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? KSTARTUP_DETAIL_REQUEST_DELAY_MS;
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchKStartupDetail(url, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs,
        ...(options.fetchedAt !== undefined ? { fetchedAt: options.fetchedAt } : {}),
      });
      return { ok: true, content: result.content };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }
  return { ok: false, error: lastError };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 상세 페이지 URL 선택: 상세 페이지 URL 우선, 없으면 안내 URL. */
export function resolveKStartupDetailUrl(
  row: Pick<KStartupAnnouncement, "detl_pg_url" | "biz_gdnc_url">,
): string | null {
  const candidate = row.detl_pg_url?.trim() || row.biz_gdnc_url?.trim();
  return candidate && candidate.length > 0 ? candidate : null;
}

/**
 * 파싱된 상세 첨부를 GrantRaw.attachments 형태(파일명 + 다운로드 URL 메타데이터)로 변환한다.
 * source_uri/archive_url/sha256 등은 채우지 않는다 — 본문 다운로드를 유발하지 않기 위함.
 */
export function attachmentsFromDetail(
  detail: KStartupDetailContent,
): NonNullable<GrantRaw["attachments"]> {
  return detail.attachments.map((attachment) => ({
    filename: attachment.filename,
    url: attachment.url,
  }));
}

/**
 * Upstage Document Parse 어댑터.
 *
 * 단일 원천: 대조 문서 §3.1.
 *   - 엔드포인트: POST https://api.upstage.ai/v1/document-digitization (동기)
 *   - 인증: Authorization: Bearer ${UPSTAGE_API_KEY}
 *   - 요청: multipart/form-data. document=페이지 PNG, model=document-parse,
 *           coordinates=true, output_formats=["text"], ocr=auto
 *   - 응답 bbox: element.coordinates = 페이지 대비 0~1 4점 (변환 불필요, 4점→AABB)
 *   - rate limit: 동기 1 RPS → 직렬 + 429 지수 백오프
 *   - 가격: Parse $0.01/p
 */
import { basename } from "node:path";
import type { DocumentInput, LayoutEngineAdapter, PageInput } from "../types";
import { unsupportedDocumentMode } from "../types";
import { normalizeUpstage } from "../normalize";
import { RateLimiter, fetchWithRetry, readFileBuffer } from "./http";

const ENDPOINT = "https://api.upstage.ai/v1/document-digitization";
const DEFAULT_MODEL = "document-parse";
// 동기 1 RPS 준수(대조 §5-6). 약간 여유를 둔다.
const limiter = new RateLimiter(1100);

function model(): string {
  return process.env.UPSTAGE_DOCUMENT_PARSE_MODEL?.trim() || DEFAULT_MODEL;
}

export const upstageAdapter: LayoutEngineAdapter = {
  name: "upstage",
  layer: "layout",
  mode: "page",
  requires: "UPSTAGE_API_KEY",
  costPerPageUsd: 0.01,

  isConfigured(): boolean {
    return Boolean(process.env.UPSTAGE_API_KEY?.trim());
  },

  engineVersion(): string {
    return model();
  },

  async fetchPage(input: PageInput): Promise<unknown> {
    const apiKey = process.env.UPSTAGE_API_KEY?.trim();
    if (!apiKey) throw new Error("upstage: UPSTAGE_API_KEY 미설정");

    const buf = await readFileBuffer(input.pngPath);
    const form = new FormData();
    form.append(
      "document",
      new Blob([new Uint8Array(buf)], { type: "image/png" }),
      basename(input.pngPath),
    );
    form.append("model", model());
    form.append("coordinates", "true");
    form.append("output_formats", '["text"]');
    form.append("ocr", "auto");

    const res = await fetchWithRetry(
      ENDPOINT,
      { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form },
      { retries: 4, baseDelayMs: 1000, limiter },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`upstage: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    return (await res.json()) as unknown;
  },

  fetchDocument(_input: DocumentInput): Promise<unknown> {
    return Promise.resolve(unsupportedDocumentMode("upstage"));
  },

  normalizePage(raw: unknown, ctx: PageInput) {
    return normalizeUpstage(raw, ctx.page);
  },

  normalizeDocument(_raw: unknown, _ctx: DocumentInput) {
    return unsupportedDocumentMode("upstage");
  },
};

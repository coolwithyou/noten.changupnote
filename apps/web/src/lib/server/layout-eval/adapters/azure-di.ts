/**
 * Azure Document Intelligence (prebuilt-layout) 어댑터 — REST 2024-11-30 + LRO 폴링.
 *
 * 단일 원천: 대조 문서 §3.3, §5.
 *   - POST {AZURE_DI_ENDPOINT}/documentintelligence/documentModels/prebuilt-layout:analyze
 *       ?api-version=2024-11-30, JSON body { base64Source: <base64 PNG> }
 *   - 인증: Ocp-Apim-Subscription-Key: ${AZURE_DI_KEY}
 *   - 비동기 LRO: 202 → Operation-Location 헤더 폴링(status succeeded/failed)
 *   - polygon(이미지 px) → x/page.width, y/page.height (page.unit 분기는 normalize.ts)
 *   - selection mark → checkbox 후보(라벨 연결 없음 — 후보만)
 *   - 가격: Layout ~$10/1,000p = $0.01/p
 */
import type { DocumentInput, LayoutEngineAdapter, PageInput } from "../types";
import { unsupportedDocumentMode } from "../types";
import { normalizeAzureLayout } from "../normalize";
import { RateLimiter, fetchWithRetry, readFileBase64, sleep } from "./http";

const API_VERSION = "2024-11-30";
const limiter = new RateLimiter(600);
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 60;

function endpoint(): string {
  return (process.env.AZURE_DI_ENDPOINT?.trim() ?? "").replace(/\/+$/, "");
}
function apiKey(): string {
  return process.env.AZURE_DI_KEY?.trim() ?? "";
}

export const azureDiAdapter: LayoutEngineAdapter = {
  name: "azure-di",
  layer: "layout",
  mode: "page",
  requires: "AZURE_DI_ENDPOINT + AZURE_DI_KEY",
  costPerPageUsd: 0.01,

  isConfigured(): boolean {
    return Boolean(endpoint() && apiKey());
  },

  engineVersion(): string {
    return `prebuilt-layout-${API_VERSION}`;
  },

  async fetchPage(input: PageInput): Promise<unknown> {
    const base = endpoint();
    const key = apiKey();
    if (!base || !key) throw new Error("azure-di: AZURE_DI_ENDPOINT/AZURE_DI_KEY 미설정");

    const analyzeUrl = `${base}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${API_VERSION}`;
    const base64Source = await readFileBase64(input.pngPath);
    const submit = await fetchWithRetry(
      analyzeUrl,
      {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ base64Source }),
      },
      { retries: 4, baseDelayMs: 1000, limiter },
    );
    if (submit.status !== 202) {
      const t = await submit.text().catch(() => "");
      throw new Error(`azure-di: analyze ${submit.status} ${submit.statusText} ${t.slice(0, 300)}`);
    }
    const opLocation = submit.headers.get("operation-location");
    if (!opLocation) throw new Error("azure-di: Operation-Location 헤더 없음");

    // LRO 폴링
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await fetchWithRetry(
        opLocation,
        { method: "GET", headers: { "Ocp-Apim-Subscription-Key": key } },
        { retries: 4, baseDelayMs: 1000, limiter },
      );
      if (!poll.ok) {
        const t = await poll.text().catch(() => "");
        throw new Error(`azure-di: poll ${poll.status} ${poll.statusText} ${t.slice(0, 200)}`);
      }
      const json = (await poll.json()) as Record<string, unknown>;
      const status = typeof json["status"] === "string" ? json["status"] : "";
      if (status === "succeeded") return json;
      if (status === "failed") {
        throw new Error(`azure-di: 분석 실패 ${JSON.stringify(json["error"] ?? {}).slice(0, 300)}`);
      }
    }
    throw new Error("azure-di: LRO 폴링 타임아웃");
  },

  fetchDocument(_input: DocumentInput): Promise<unknown> {
    return Promise.resolve(unsupportedDocumentMode("azure-di"));
  },

  normalizePage(raw: unknown, ctx: PageInput) {
    return normalizeAzureLayout(raw, ctx.page);
  },

  normalizeDocument(_raw: unknown, _ctx: DocumentInput) {
    return unsupportedDocumentMode("azure-di");
  },
};

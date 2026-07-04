/**
 * Google Document AI (Form Parser) 어댑터 — REST fetch + gcloud 액세스 토큰.
 *
 * 단일 원천: 대조 문서 §3.2, §5.
 *   - @google-cloud/documentai SDK 대신 REST fetch (의존성 최소화)
 *   - 액세스 토큰: `gcloud auth print-access-token` 자식 프로세스 (SA 키 관리 회피)
 *   - 프로세서: GOOGLE_DOCAI_PROCESSOR = 전체 리소스명
 *       projects/{p}/locations/{loc}/processors/{id}[/processorVersions/{ver}]
 *     → 호스트 {loc}-documentai.googleapis.com, `:process` 호출, rawDocument=base64 PNG
 *   - bbox: normalizedVertices(0~1) 사용 + 0 생략 보정 (normalize.ts)
 *   - formFields·표 셀·visualElements(체크박스) → 후보
 *   - 가격: Form Parser $30/1,000p = $0.03/p
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DocumentInput, LayoutEngineAdapter, PageInput } from "../types";
import { unsupportedDocumentMode } from "../types";
import { normalizeGoogleDocAI } from "../normalize";
import { RateLimiter, fetchWithRetry, readFileBase64 } from "./http";

const execFileAsync = promisify(execFile);
// GCP 쿼터 보수적 직렬(대조 §5-6).
const limiter = new RateLimiter(600);

function processorName(): string {
  return process.env.GOOGLE_DOCAI_PROCESSOR?.trim() ?? "";
}

/** 프로세서 리소스명에서 location 추출 (locations/{loc}). */
function locationOf(name: string): string {
  const m = name.match(/\/locations\/([^/]+)/);
  return m?.[1] ?? "us";
}

/** gcloud 로 액세스 토큰 획득. gcloud 미설치/미인증이면 명확한 에러. */
async function accessToken(): Promise<string> {
  const bin = process.env.GCLOUD_BIN?.trim() || "gcloud";
  try {
    const { stdout } = await execFileAsync(bin, ["auth", "print-access-token"], {
      timeout: 20_000,
    });
    const token = stdout.trim();
    if (!token) throw new Error("빈 토큰");
    return token;
  } catch (error) {
    throw new Error(
      `google-docai: gcloud 액세스 토큰 획득 실패 (gcloud auth login 필요): ${(error as Error).message}`,
    );
  }
}

export const googleDocaiAdapter: LayoutEngineAdapter = {
  name: "google-docai",
  layer: "layout",
  mode: "page",
  requires: "GOOGLE_DOCAI_PROCESSOR (+ gcloud 인증)",
  costPerPageUsd: 0.03,

  isConfigured(): boolean {
    return Boolean(processorName());
  },

  engineVersion(): string {
    const name = processorName();
    // 프로세서 버전이 리소스명에 있으면 그걸, 아니면 프로세서 id, 최후 폴백.
    const verMatch = name.match(/\/processorVersions\/([^/]+)/);
    if (verMatch?.[1]) return `form-parser-${verMatch[1]}`;
    const override = process.env.GOOGLE_DOCAI_PROCESSOR_VERSION?.trim();
    if (override) return `form-parser-${override}`;
    const idMatch = name.match(/\/processors\/([^/]+)/);
    return idMatch?.[1] ? `form-parser-${idMatch[1]}` : "form-parser-default";
  },

  async fetchPage(input: PageInput): Promise<unknown> {
    const name = processorName();
    if (!name) throw new Error("google-docai: GOOGLE_DOCAI_PROCESSOR 미설정");
    const loc = locationOf(name);
    const url = `https://${loc}-documentai.googleapis.com/v1/${name}:process`;
    const token = await accessToken();
    const content = await readFileBase64(input.pngPath);
    const body = JSON.stringify({
      skipHumanReview: true,
      rawDocument: { content, mimeType: "image/png" },
    });
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      },
      { retries: 4, baseDelayMs: 1000, limiter },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`google-docai: ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    return (await res.json()) as unknown;
  },

  fetchDocument(_input: DocumentInput): Promise<unknown> {
    return Promise.resolve(unsupportedDocumentMode("google-docai"));
  },

  normalizePage(raw: unknown, ctx: PageInput) {
    return normalizeGoogleDocAI(raw, ctx.page);
  },

  normalizeDocument(_raw: unknown, _ctx: DocumentInput) {
    return unsupportedDocumentMode("google-docai");
  },
};

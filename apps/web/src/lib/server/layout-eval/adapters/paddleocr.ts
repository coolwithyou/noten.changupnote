/**
 * PaddleOCR PP-StructureV3 어댑터 — 셀프호스팅 HTTP.
 *
 * 단일 원천: 대조 문서 §3.5, §5.
 *   - PADDLEOCR_SERVER_URL 로 페이지 이미지 POST
 *   - 응답 스키마는 서버 구성(PaddleX 서비스형/커스텀)에 따라 다르므로,
 *     PP-StructureV3 layout/table 출력(box + label + score) 가정으로 파싱하고,
 *     기대 형태가 아니면 명확한 에러를 던진다.
 *   - box(px) → 렌더 페이지 px 로 나눔 (normalize.ts, canonical 중간표현)
 *
 * ── Docker 실행 지침(로컬 CPU) ──────────────────────────────────────────────
 *   PP-StructureV3 를 서빙하는 방법은 여러 가지다(공식 단일 이미지 미표준화, 대조 §3.5).
 *   PaddleX 파이프라인 서빙 예:
 *     docker run -d --name paddle-struct -p 8080:8080 \
 *       ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlex/paddlex:paddlex3.0.0-paddlepaddle3.0.0-cpu \
 *       bash -c "paddlex --serve --pipeline PP-StructureV3 --host 0.0.0.0 --port 8080"
 *   그 뒤 .env.local 에 PADDLEOCR_SERVER_URL=http://127.0.0.1:8080/layout-parsing 지정.
 *   (엔드포인트 경로/응답 키는 서빙 구성마다 다르므로 실서버 확인 후 adaptResponse 를 맞출 것)
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { BBox, DocumentInput, LayoutEngineAdapter, PageInput } from "../types";
import { unsupportedDocumentMode } from "../types";
import { normalizePaddleStructure } from "../normalize";
import { RateLimiter, fetchWithRetry, readFileBase64 } from "./http";

const limiter = new RateLimiter(300);

function serverUrl(): string {
  return process.env.PADDLEOCR_SERVER_URL?.trim() ?? "";
}

/** canonical 중간표현: normalize.ts 가 기대하는 형태. */
interface PaddleCanonical {
  imageWidth: number;
  imageHeight: number;
  boxes: Array<{ bbox: BBox; label: string; score: number; text: string }>;
}

/** 숫자 4개(px) → [x1,y1,x2,y2]. PP-Structure box 는 [x1,y1,x2,y2] 또는 4점 폴리곤일 수 있다. */
function toXyxy(coord: unknown): BBox | null {
  if (!Array.isArray(coord)) return null;
  const nums = coord.flat(Infinity).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (nums.length < 4) return null;
  if (nums.length === 4) return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
  // 4점 폴리곤 [x1,y1,...] → min/max
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    xs.push(nums[i] as number);
    ys.push(nums[i + 1] as number);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * 서버 원시 응답 → canonical. PP-StructureV3/PaddleX 의 흔한 형태를 여러 키로 탐색하되,
 * 어떤 형태로도 layout box 를 못 찾으면 스키마 불일치로 명확히 실패한다.
 */
function adaptResponse(raw: unknown): PaddleCanonical {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const result = (rec["result"] ?? rec) as Record<string, unknown>;
  const results =
    (result["layoutParsingResults"] as unknown) ??
    (result["layout_parsing_results"] as unknown) ??
    (result["layoutParsingResult"] as unknown) ??
    null;
  const first = Array.isArray(results) ? (results[0] as Record<string, unknown> | undefined) : (result as Record<string, unknown>);
  if (!first) {
    throw new Error(
      "paddleocr: 응답에서 layoutParsingResults 를 찾지 못함 — 서버 구성/엔드포인트를 확인하세요 (PP-StructureV3 layout 출력 가정).",
    );
  }

  const detRes =
    (first["layoutDetResults"] as unknown) ??
    (first["layout_det_res"] as unknown) ??
    (first["boxes"] as unknown) ??
    null;
  const detRec = (detRes ?? {}) as Record<string, unknown>;
  const rawBoxes =
    (Array.isArray(detRes) ? detRes : null) ??
    (detRec["boxes"] as unknown) ??
    (first["boxes"] as unknown) ??
    null;
  if (!Array.isArray(rawBoxes)) {
    throw new Error(
      "paddleocr: layout box 배열을 찾지 못함 — 기대 형태 { boxes:[{coordinate|bbox:[x1,y1,x2,y2], label, score}] } 와 불일치.",
    );
  }

  // 이미지 크기: 여러 키 후보 탐색
  const size =
    (first["inputImgShape"] as unknown) ??
    (first["input_img_shape"] as unknown) ??
    (first["imageSize"] as unknown) ??
    (first["image_size"] as unknown) ??
    null;
  let imageWidth = 0;
  let imageHeight = 0;
  if (Array.isArray(size) && size.length >= 2) {
    // [h, w] (PaddleX 관례) 로 가정
    imageHeight = Number(size[0]) || 0;
    imageWidth = Number(size[1]) || 0;
  } else if (size && typeof size === "object") {
    const s = size as Record<string, unknown>;
    imageWidth = Number(s["width"]) || 0;
    imageHeight = Number(s["height"]) || 0;
  }
  if (!(imageWidth > 0 && imageHeight > 0)) {
    throw new Error(
      "paddleocr: 이미지 크기(input_img_shape/image_size)를 찾지 못함 — px→0~1 정규화 불가.",
    );
  }

  const boxes: PaddleCanonical["boxes"] = [];
  for (const b of rawBoxes) {
    if (typeof b !== "object" || b === null) continue;
    const box = b as Record<string, unknown>;
    const bbox = toXyxy(box["coordinate"] ?? box["bbox"] ?? box["box"]);
    if (!bbox) continue;
    boxes.push({
      bbox,
      label: typeof box["label"] === "string" ? box["label"] : "",
      score: typeof box["score"] === "number" ? box["score"] : 0,
      text: typeof box["text"] === "string" ? box["text"] : "",
    });
  }
  return { imageWidth, imageHeight, boxes };
}

export const paddleocrAdapter: LayoutEngineAdapter = {
  name: "paddleocr",
  layer: "layout",
  mode: "page",
  requires: "PADDLEOCR_SERVER_URL",
  costPerPageUsd: 0, // 셀프호스팅(자체 컴퓨트)

  isConfigured(): boolean {
    return Boolean(serverUrl());
  },

  engineVersion(): string {
    return process.env.PADDLEOCR_ENGINE_VERSION?.trim() || "pp-structurev3";
  },

  async fetchPage(input: PageInput): Promise<unknown> {
    const url = serverUrl();
    if (!url) throw new Error("paddleocr: PADDLEOCR_SERVER_URL 미설정");
    const file = await readFileBase64(input.pngPath);
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // PaddleX 서비스형 관례: { file: <base64>, fileType: 1(=이미지) }
        body: JSON.stringify({ file, fileType: 1 }),
      },
      { retries: 3, baseDelayMs: 1000, limiter },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`paddleocr: ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const raw = (await res.json()) as unknown;
    // 원시 응답을 canonical 로 어댑팅해 캐시에 저장(정규화는 canonical 기준).
    return adaptResponse(raw);
  },

  fetchDocument(_input: DocumentInput): Promise<unknown> {
    return Promise.resolve(unsupportedDocumentMode("paddleocr"));
  },

  normalizePage(raw: unknown, ctx: PageInput) {
    return normalizePaddleStructure(raw, ctx.page);
  },

  normalizeDocument(_raw: unknown, _ctx: DocumentInput) {
    return unsupportedDocumentMode("paddleocr");
  },
};

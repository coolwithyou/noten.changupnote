/**
 * kordoc 어댑터 — text parser 계층(§8.5). bbox 미반환(row/col 논리 인덱스만).
 *
 * 단일 원천: 대조 문서 §3.4, §5-7.
 *   - npm kordoc@3.13.0 (버전 핀), 키 불필요, 로컬 실행
 *   - 원본 파일(spike-samplesN/files) 을 parse() → extractFormFields()
 *   - form field 는 bbox 가 없다 → 후보는 bbox:null, page:null, layer:"text_parser"
 *     (layout 엔진 측정표와 분리; label/text 매칭으로만 평가)
 *   - inferFieldType(label, value) 로 fieldType 을 부여해 kind 매핑 근거로 남긴다
 */
import { extractFormFields, inferFieldType, parse, VERSION } from "kordoc";
import type { DocumentInput, LayoutEngineAdapter, PageInput } from "../types";
import { unsupportedPageMode } from "../types";
import { normalizeKordoc } from "../normalize";
import { readFileBuffer } from "./http";

export const kordocAdapter: LayoutEngineAdapter = {
  name: "kordoc",
  layer: "text_parser",
  mode: "document",
  requires: "", // 로컬 라이브러리 — 항상 사용 가능
  costPerPageUsd: 0,

  isConfigured(): boolean {
    return true;
  },

  engineVersion(): string {
    return `kordoc-${VERSION}`;
  },

  fetchPage(_input: PageInput): Promise<unknown> {
    return Promise.resolve(unsupportedPageMode("kordoc"));
  },

  async fetchDocument(input: DocumentInput): Promise<unknown> {
    const buf = await readFileBuffer(input.sourceFilePath);
    const result = await parse(buf);
    if (!result.success) {
      throw new Error(`kordoc: parse 실패 (${input.sourceFilePath}): ${result.error}`);
    }
    const form = extractFormFields(result.blocks);
    // normalize 가 kordoc 의존 없이 kind 를 매길 수 있도록 fieldType 을 부여해 둔다.
    const fields = form.fields.map((f) => ({
      label: f.label,
      value: f.value,
      row: f.row,
      col: f.col,
      fieldType: inferFieldType(f.label, f.value),
    }));
    return {
      engine: "kordoc",
      version: VERSION,
      confidence: form.confidence,
      blockCount: result.blocks.length,
      fields,
    };
  },

  normalizePage(_raw: unknown, _ctx: PageInput) {
    return unsupportedPageMode("kordoc");
  },

  normalizeDocument(raw: unknown, _ctx: DocumentInput) {
    return normalizeKordoc(raw);
  },
};

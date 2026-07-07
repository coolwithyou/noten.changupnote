#!/usr/bin/env node
// kordoc 병행 측정 (hwp2hwpx Phase 0, 전제 6 / 개선 후보 4절). 측정만 — 채택 판단 금지.
// 동일 샘플(spike-samples/files/*.hwp, 22건)로 kordoc 의 .hwp 네이티브 읽기/채움을
// Java(hwp2hwpx) 트랙과 대조. 실패/불일치는 그대로 기록(우회 시도 최소).
//
// 산출: spike-out/hwp2hwpx/kordoc/*.hwpx(있으면), kordoc-results.json

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectFormat,
  isOldHwpFile,
  parseHwp,
  extractFormFields,
  fillForm,
  isHwpxFile,
} from "kordoc";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SAMPLES = join(ROOT, "spike-samples/files");
const OUT = join(ROOT, "spike-out/hwp2hwpx");
const KOUT = join(OUT, "kordoc");
mkdirSync(KOUT, { recursive: true });

// Java 트랙과 동일 라벨 세트(run-core.mjs 와 일치).
const VALUES = {
  기업명: "주식회사 채움검증", 업체명: "주식회사 채움검증", 기업체명: "주식회사 채움검증", 회사명: "주식회사 채움검증",
  사업자등록번호: "123-45-67890", 법인등록번호: "110111-1234567",
  대표자: "홍길동", 대표자명: "홍길동", 성명: "홍길동",
  주소: "서울특별시 강남구 테헤란로 1", 소재지: "서울특별시 강남구 테헤란로 1",
  연락처: "02-1234-5678", 전화번호: "02-1234-5678", 휴대폰: "010-1234-5678",
  이메일: "test@example.com", "E-mail": "test@example.com",
  설립일: "2020-01-01", 설립연월일: "2020-01-01",
  업종: "정보통신업 & 소프트웨어 <개발>",
};

function toAB(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function tableStats(blocks) {
  let tables = 0, cells = 0, empty = 0;
  for (const b of blocks || []) {
    if (b.type === "table" && b.table) {
      tables++;
      for (const rowArr of b.table.cells || []) for (const c of rowArr) {
        cells++;
        if (!c.text || c.text.trim() === "") empty++;
      }
    }
  }
  return { tables, cells, empty };
}

const files = readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith(".hwp")).sort();
const rows = [];

for (const f of files) {
  const buf = readFileSync(join(SAMPLES, f));
  const row = { file: f, detect: null, isOldHwp: null, parse: null, fields: null, fill: null };
  try { row.detect = detectFormat(toAB(buf)); } catch (e) { row.detect = "err:" + (e.message || e).slice(0, 60); }
  try { row.isOldHwp = isOldHwpFile(toAB(buf)); } catch { row.isOldHwp = null; }

  // 1) parseHwp (.hwp 네이티브 읽기)
  try {
    const pr = await parseHwp(toAB(buf));
    if (pr.success) {
      const st = tableStats(pr.blocks);
      row.parse = { ok: true, mdChars: (pr.markdown || "").length, ...st };
      // 2) 필드 추출
      try {
        const fr = extractFormFields(pr.blocks);
        row.fields = { count: fr.fields.length, confidence: fr.confidence };
      } catch (e) { row.fields = { error: (e.message || String(e)).slice(0, 120) }; }
    } else {
      row.parse = { ok: false, error: (pr.error || pr.reason || "parse failed") + "" };
    }
  } catch (e) { row.parse = { ok: false, error: (e.message || String(e)).slice(0, 160) }; }

  // 3) fillForm — .hwp 직접 채움 (아키텍처 축약 경로). 기본 outputFormat 자동.
  try {
    const res = await fillForm(buf, VALUES);
    const out = res.output;
    let savedHwpx = false, outTables = null;
    if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
      const ob = Buffer.from(out instanceof ArrayBuffer ? out : out.buffer);
      const isHwpx = (() => { try { return isHwpxFile(toAB(ob)); } catch { return false; } })();
      if (isHwpx) {
        writeFileSync(join(KOUT, f.replace(/\.hwp$/i, ".kordoc.hwpx")), ob);
        savedHwpx = true;
      }
    }
    row.fill = {
      format: res.format,
      filled: res.fill.filled.length,
      filledLabels: res.fill.filled.map((x) => x.label).slice(0, 30),
      unmatched: res.fill.unmatched.length,
      outputType: out instanceof ArrayBuffer ? "hwpx-buffer" : typeof out,
      savedHwpx,
    };
  } catch (e) { row.fill = { error: (e.message || String(e)).slice(0, 200) }; }

  rows.push(row);
  const p = row.parse, fl = row.fill;
  console.log(`${f}\n  detect=${row.detect} oldHwp=${row.isOldHwp} | parse=${p.ok ? `OK tbl=${p.tables} cell=${p.cells} empty=${p.empty} md=${p.mdChars}` : "FAIL:" + p.error}` +
    ` | fields=${row.fields ? (row.fields.count ?? "err") : "-"} | fill=${fl.error ? "ERR:" + fl.error : `${fl.format} ${fl.filled}채움/${fl.unmatched}미매칭 out=${fl.outputType}`}`);
}

const parseOk = rows.filter((r) => r.parse && r.parse.ok).length;
const fillOk = rows.filter((r) => r.fill && !r.fill.error && r.fill.filled > 0).length;
const fillErr = rows.filter((r) => r.fill && r.fill.error).length;
const hwpxOut = rows.filter((r) => r.fill && r.fill.savedHwpx).length;
const summary = {
  total: files.length,
  parseOk, parseFail: files.length - parseOk,
  fillDidFill: fillOk, fillError: fillErr,
  producedHwpx: hwpxOut,
  fillFormats: rows.reduce((a, r) => { const k = r.fill && !r.fill.error ? r.fill.format : "error"; a[k] = (a[k] || 0) + 1; return a; }, {}),
};
writeFileSync(join(OUT, "kordoc-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), kordocVersion: "3.17.0", summary, rows }, null, 2));
console.log("\n=== kordoc 요약 ===");
console.log(JSON.stringify(summary, null, 2));

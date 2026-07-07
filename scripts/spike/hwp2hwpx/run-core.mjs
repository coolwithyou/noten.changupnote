#!/usr/bin/env node
// hwp2hwpx Phase 0 — 전수 변환 + 구조 단정 + 채움 왕복 (core dist 사용).
// 사용법: node scripts/spike/hwp2hwpx/run-core.mjs
// 산출: spike-out/hwp2hwpx/converted/*.hwpx, filled/*.hwpx, core-results.json
//
// java -jar 로 .hwp -> .hwpx 변환(호스트 JRE) 후, @cunote/core dist 의
// readHwpxEntries/scanTableCells/fillHwpxTemplate 로 변환 산출물 자체를 검증한다.
// (네이티브 hwpx 샘플로 대체 금지 — 변환 출력으로 측정.)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectHwpFormat,
  readHwpxEntries,
  scanTableCells,
  fillHwpxTemplate,
} from "../../../packages/core/dist/documents/hwpx-fill.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SAMPLES = join(ROOT, "spike-samples/files");
const OUT = join(ROOT, "spike-out/hwp2hwpx");
const CONVERTED = join(OUT, "converted");
const FILLED = join(OUT, "filled");
const JAR = join(OUT, "hwp2hwpx-cli.jar");
mkdirSync(CONVERTED, { recursive: true });
mkdirSync(FILLED, { recursive: true });

// 채움 라벨 세트 — hwpx-fill-integration.ts 와 동일(비교 가능성 확보).
const VALUES = {
  기업명: "주식회사 채움검증",
  업체명: "주식회사 채움검증",
  기업체명: "주식회사 채움검증",
  회사명: "주식회사 채움검증",
  사업자등록번호: "123-45-67890",
  법인등록번호: "110111-1234567",
  대표자: "홍길동",
  대표자명: "홍길동",
  성명: "홍길동",
  주소: "서울특별시 강남구 테헤란로 1",
  소재지: "서울특별시 강남구 테헤란로 1",
  연락처: "02-1234-5678",
  전화번호: "02-1234-5678",
  휴대폰: "010-1234-5678",
  이메일: "test@example.com",
  "E-mail": "test@example.com",
  설립일: "2020-01-01",
  설립연월일: "2020-01-01",
  업종: "정보통신업 & 소프트웨어 <개발>",
};

function classifyFailure(stderr, magic, head) {
  const s = (stderr || "").toLowerCase();
  if (magic !== "hwp-binary" && /hwp document file v3|hwp document file v2/i.test(head)) return "hwp-3x";
  if (magic === "unknown") return "not-hwp5-container";
  if (/password|encrypt|암호|비밀번호/.test(s)) return "encrypted";
  if (/distribut|배포|drm/.test(s)) return "distribution";
  return "other";
}

function structAssert(buf) {
  const entries = readHwpxEntries(buf);
  const sections = entries.filter((e) => /^Contents\/section\d+\.xml$/.test(e.name));
  let tables = new Set();
  let cells = 0;
  let emptyCells = 0;
  let withAddr = 0;
  let fieldBegin = 0;
  for (const sec of sections) {
    const xml = sec.data.toString("utf8");
    fieldBegin += (xml.match(/<hp:fieldBegin\b/g) || []).length;
    const cs = scanTableCells(xml);
    for (const c of cs) {
      tables.add(`${sec.name}#${c.tableIndex}`);
      cells++;
      if (c.isEmpty) emptyCells++;
      if (c.colAddr >= 0 && c.rowAddr >= 0) withAddr++;
    }
  }
  return {
    sections: sections.length,
    tables: tables.size,
    cells,
    emptyCells,
    cellsWithAddr: withAddr,
    fieldBegin,
    structureOk: tables.size > 0 && cells > 0 && withAddr === cells,
  };
}

const files = readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith(".hwp")).sort();
const rows = [];

for (const f of files) {
  const inPath = join(SAMPLES, f);
  const buf = readFileSync(inPath);
  const magic = detectHwpFormat(buf);
  const head = buf.subarray(0, 64).toString("latin1");
  const outPath = join(CONVERTED, f.replace(/\.hwp$/i, ".hwpx"));

  const row = { file: f, magic, convert: null, meta: null, failReason: null, struct: null, fill: null };

  // 변환
  let stdout = "";
  let convertOk = false;
  try {
    stdout = execFileSync("java", ["-jar", JAR, inPath, outPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    convertOk = true;
    row.meta = stdout.trim().replace(/^OK\s*/, "");
  } catch (err) {
    const stderr = String(err.stderr || err.message || "");
    row.failReason = classifyFailure(stderr, magic, head);
    row.convertError = stderr.trim().split("\n").slice(-1)[0].slice(0, 300);
  }
  row.convert = convertOk ? "ok" : "fail";

  if (convertOk) {
    // 구조 단정
    const outBuf = readFileSync(outPath);
    try {
      row.struct = structAssert(outBuf);
    } catch (err) {
      row.struct = { error: String(err.message || err) };
    }
    // 채움 왕복
    try {
      const res = fillHwpxTemplate({ source: outBuf, values: VALUES });
      const filledPath = join(FILLED, f.replace(/\.hwp$/i, ".filled.hwpx"));
      writeFileSync(filledPath, res.output);
      const reasonCounts = {};
      for (const u of res.unfilled) reasonCounts[u.reason] = (reasonCounts[u.reason] || 0) + 1;
      row.fill = {
        filled: res.filled.length,
        filledLabels: res.filled.map((x) => x.label),
        unfilled: res.unfilled.length,
        unfilledReasons: reasonCounts,
        hadFieldBegin: (row.struct?.fieldBegin || 0) > 0,
      };
    } catch (err) {
      row.fill = { error: String(err.message || err) };
    }
  }
  rows.push(row);

  const tag = convertOk ? "OK  " : `FAIL[${row.failReason}]`;
  const s = row.struct;
  const fl = row.fill;
  console.log(
    `${tag} ${f}\n     ${convertOk ? `struct: tbl=${s.tables} cell=${s.cells} empty=${s.emptyCells} addr=${s.cellsWithAddr} field=${s.fieldBegin} | fill: ${fl.filled}채움 [${fl.filledLabels.join(",")}] ${fl.unfilled}미채움 ${JSON.stringify(fl.unfilledReasons)}` : row.convertError}`,
  );
}

const convertOk = rows.filter((r) => r.convert === "ok").length;
const convertFail = rows.filter((r) => r.convert === "fail");
const unclassified = convertFail.filter((r) => r.failReason === "other" && !r.convertError);
const emptyPreserved = rows.filter((r) => r.struct && r.struct.emptyCells > 0).length;
const fillWorked = rows.filter((r) => r.fill && r.fill.filled > 0).length;
const honestReport = rows.filter((r) => r.fill && r.fill.unfilled > 0).length;
const withFields = rows.filter((r) => r.struct && r.struct.fieldBegin > 0).length;

const summary = {
  total: files.length,
  convertOk,
  convertFail: convertFail.length,
  failByReason: convertFail.reduce((a, r) => ((a[r.failReason] = (a[r.failReason] || 0) + 1), a), {}),
  unclassifiedFail: unclassified.length,
  structEmptyPreservedDocs: emptyPreserved,
  fillSuccessDocs: fillWorked,
  fillHonestReportDocs: honestReport,
  docsWithFieldBegin: withFields,
};
writeFileSync(join(OUT, "core-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));

console.log("\n=== core 요약 ===");
console.log(JSON.stringify(summary, null, 2));
console.log(`\n산출: ${CONVERTED}/*.hwpx, ${FILLED}/*.filled.hwpx, ${OUT}/core-results.json`);

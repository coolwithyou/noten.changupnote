#!/usr/bin/env node
// 렌더 게이트 — 컨테이너(cunote-conversion:spike) 내부 실행. 리포 /work 마운트 전제.
// 원본 .hwp / 변환 .hwpx(STORE 정규화) / 채움 .hwpx 를 soffice(+H2Orestart)로 렌더, 페이지 수 대조.
//
// 주의(실측 근거): hwp2hwpx 는 mimetype 을 DEFLATE 로 저장 → H2O 가 hwpx 로 인식 못 함(no pdf).
//   production 경로(draftHwpxExport/fillHwpxTemplate)는 core writeHwpx 로 재포장하며
//   mimetype 을 STORE 로 정규화하므로, 공정한 비교는 STORE 정규화본으로 한다.
//   STORE 정규화 후에도 다수 문서는 H2O importer 가 SIGABRT 로 crash(ImportFrom) — 오라클 한계.
//
// 산출: spike-out/hwp2hwpx/render/{orig,conv,filled}/*.pdf, render/png/*, render-results.json

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readHwpxEntries, writeHwpx } from "/work/packages/core/dist/documents/hwpx-fill.js";

const ROOT = "/work";
const OUT = join(ROOT, "spike-out/hwp2hwpx");
const RENDER = join(OUT, "render");
const PNG = join(RENDER, "png");
mkdirSync(PNG, { recursive: true });

function prefix(f) {
  const m = /^(\d+)_/.exec(f);
  return m ? m[1] : f;
}

// input: 파일 경로. 반환: { mode: "ok"|"sniff-fail"|"importer-crash", pages }
function renderPath(input, outDir) {
  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "lo."));
  let exitOk = true;
  try {
    execFileSync("soffice", [`-env:UserInstallation=file://${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, input], { stdio: "pipe", timeout: 180000 });
  } catch {
    exitOk = false; // soffice 비정상 종료(=importer crash 등)
  }
  const pdf = join(outDir, basename(input).replace(/\.[^.]+$/, ".pdf"));
  if (existsSync(pdf)) return { mode: "ok", pages: pageCount(pdf), pdf };
  return { mode: exitOk ? "sniff-fail" : "importer-crash", pages: null, pdf: null };
}

function pageCount(pdf) {
  try {
    const out = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
    const m = /Pages:\s+(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function savePng(pdf, stem, tag) {
  try {
    execFileSync("pdftoppm", ["-png", "-r", "110", "-f", "1", "-l", "3", pdf, join(PNG, `${stem}_${tag}`)], { stdio: "pipe", timeout: 90000 });
  } catch {}
}

const origDir = join(ROOT, "spike-samples/files");
const convDir = join(OUT, "converted");
const filledDir = join(OUT, "filled");
const normDir = join(RENDER, "conv-store"); // STORE 정규화본 임시 저장
mkdirSync(normDir, { recursive: true });

const origs = readdirSync(origDir).filter((f) => f.toLowerCase().endsWith(".hwp")).sort();
const rows = [];
let pngSaved = 0;

for (const f of origs) {
  const px = prefix(f);
  const convName = f.replace(/\.hwp$/i, ".hwpx");
  const filledName = f.replace(/\.hwp$/i, ".filled.hwpx");
  const row = { prefix: px, file: f };

  // 원본
  const o = renderPath(join(origDir, f), join(RENDER, "orig"));
  row.origMode = o.mode; row.origPages = o.pages;

  // 변환(STORE 정규화)
  if (existsSync(join(convDir, convName))) {
    const norm = writeHwpx(readHwpxEntries(readFileSync(join(convDir, convName))));
    const normPath = join(normDir, convName);
    writeFileSync(normPath, norm);
    const c = renderPath(normPath, join(RENDER, "conv"));
    row.convMode = c.mode; row.convPages = c.pages;
    // 채움
    if (existsSync(join(filledDir, filledName))) {
      const fl = renderPath(join(filledDir, filledName), join(RENDER, "filled"));
      row.filledMode = fl.mode; row.filledPages = fl.pages;
      // 눈검수 PNG: orig+conv+filled 모두 렌더된 문서 최대 3건
      if (o.mode === "ok" && c.mode === "ok" && fl.mode === "ok" && pngSaved < 3) {
        savePng(o.pdf, px, "orig"); savePng(c.pdf, px, "conv"); savePng(fl.pdf, px, "filled");
        pngSaved++;
        row.eyeballPng = true;
      }
    }
  }
  row.pagesMatch = row.origMode === "ok" && row.convMode === "ok" && row.origPages != null && row.origPages === row.convPages;
  rows.push(row);
  console.log(`${px} orig=${row.origMode}(${row.origPages}p) conv=${row.convMode}(${row.convPages}p) filled=${row.filledMode}(${row.filledPages}p) match=${row.pagesMatch}${row.eyeballPng ? " [PNG]" : ""}`);
}

const summary = {
  total: rows.length,
  origRenderOk: rows.filter((r) => r.origMode === "ok").length,
  convRenderOk: rows.filter((r) => r.convMode === "ok").length,
  convImporterCrash: rows.filter((r) => r.convMode === "importer-crash").length,
  convSniffFail: rows.filter((r) => r.convMode === "sniff-fail").length,
  filledRenderOk: rows.filter((r) => r.filledMode === "ok").length,
  pagesMatchOfRenderable: rows.filter((r) => r.pagesMatch).length,
  pagesMismatch: rows.filter((r) => r.convMode === "ok" && r.origMode === "ok" && !r.pagesMatch).map((r) => ({ prefix: r.prefix, orig: r.origPages, conv: r.convPages })),
  crashList: rows.filter((r) => r.convMode === "importer-crash").map((r) => r.prefix),
};
writeFileSync(join(OUT, "render-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));
console.log("\n=== render 요약 ===");
console.log(JSON.stringify(summary, null, 2));

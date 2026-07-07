#!/usr/bin/env node
// 렌더 실패 원인 격리 실험 — 컨테이너 내부 실행(/work 마운트).
// 변환 hwpx 를 여러 변형으로 재포장해 H2O 로드 성공/페이지수를 비교한다.
//   raw    : hwp2hwpx 원본(mimetype DEFL)
//   store  : core writeHwpx 재포장(mimetype STORE)
//   preview: store + Preview/PrvText.txt 스텁 추가 + container.xml dangling 제거
// 결정성 확인을 위해 각 변형을 2회 렌더.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { readHwpxEntries, writeHwpx } from "/work/packages/core/dist/documents/hwpx-fill.js";

const OUT = "/work/spike-out/hwp2hwpx";
const CONV = join(OUT, "converted");
const EXP = join(OUT, "render-exp");
mkdirSync(EXP, { recursive: true });

const samples = {
  "10": "10_460724c1b589c540-_검단지역__신청서류_지원신청서.사업계획서.개인정보이용및제공동의서_.hwpx",
  "13": "13_4410dd3ad481bce0-지원신청서_및_사업계획서_양식_.hwpx",
  "17": "17_d758046d3d216a39-_별지_양식__지역주력산업육성_신청서_및_상세계획서.hwpx",
  "22": "22_5a96b52d8e701c80-붙임2._신청서_및_과제_계획서_등_서식.hwpx",
};

function render(buf, name) {
  const inPath = join(EXP, name);
  writeFileSync(inPath, buf);
  const prof = mkdtempSync(join(tmpdir(), "lo."));
  const outDir = join(EXP, "pdf");
  mkdirSync(outDir, { recursive: true });
  try {
    execFileSync("soffice", [`-env:UserInstallation=file://${prof}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, inPath], { stdio: "pipe", timeout: 180000 });
  } catch (e) {
    return { ok: false, pages: null, err: String(e.message || e).slice(0, 120) };
  }
  const pdf = join(outDir, name.replace(/\.[^.]+$/, ".pdf"));
  if (!existsSync(pdf)) return { ok: false, pages: null, err: "no pdf" };
  try {
    const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
    const m = /Pages:\s+(\d+)/.exec(info);
    return { ok: true, pages: m ? Number(m[1]) : null };
  } catch { return { ok: true, pages: null }; }
}

function variantStore(buf) {
  return writeHwpx(readHwpxEntries(buf));
}
function variantPreview(buf) {
  const entries = readHwpxEntries(buf);
  // Preview/PrvText.txt 스텁
  if (!entries.some((e) => e.name === "Preview/PrvText.txt")) {
    entries.push({ name: "Preview/PrvText.txt", data: Buffer.from("", "utf8"), method: 8 });
  }
  // container.xml 의 dangling Preview 참조 제거
  for (const e of entries) {
    if (e.name === "META-INF/container.xml") {
      let xml = e.data.toString("utf8");
      xml = xml.replace(/<ocf:rootfile[^>]*Preview\/PrvText\.txt[^>]*\/>/g, "");
      e.data = Buffer.from(xml, "utf8");
    }
  }
  return writeHwpx(entries);
}

const rows = [];
for (const [px, fname] of Object.entries(samples)) {
  const raw = readFileSync(join(CONV, fname));
  const variants = {
    raw,
    store: variantStore(raw),
    preview: variantPreview(raw),
  };
  const row = { prefix: px };
  for (const [vn, vbuf] of Object.entries(variants)) {
    const r1 = render(vbuf, `${px}_${vn}_a.hwpx`);
    const r2 = render(vbuf, `${px}_${vn}_b.hwpx`);
    row[vn] = { run1: r1, run2: r2 };
    console.log(`${px} ${vn.padEnd(8)} run1=${r1.ok ? r1.pages + "p" : "FAIL:" + r1.err} run2=${r2.ok ? r2.pages + "p" : "FAIL:" + r2.err}`);
  }
  rows.push(row);
}
writeFileSync(join(OUT, "render-experiment.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
console.log("\n산출:", join(OUT, "render-experiment.json"));

#!/usr/bin/env node
// Gate 0 HWP 렌더링 스파이크 실행기
// 사용법: node scripts/spike/hwp-render-spike.mjs <samples_dir> [--out <out_dir>]
// 계획: docs/gate0-hwp-render-spike-plan.md
//
// 하는 일:
//   1. samples_dir의 *.hwp / *.hwpx 를 엔진별로 PDF 변환
//      - lo: LibreOffice headless + H2Orestart (soffice)
//      - custom: 환경변수 HWP_RENDER_CMD 로 지정한 커맨드 ({in} {outdir} 치환)
//   2. poppler(pdftoppm)가 있으면 앞 2쪽 썸네일 생성
//   3. report.html(육안 비교) + scores.csv(채점표) + summary.json 생성

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("사용법: node scripts/spike/hwp-render-spike.mjs <samples_dir> [--out <out_dir>]");
  process.exit(1);
}
const samplesDir = resolve(args[0]);
const outDir = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "./spike-out");
mkdirSync(outDir, { recursive: true });

function which(bin) {
  try {
    return execSync(`command -v ${bin}`, { encoding: "utf8", shell: "/bin/sh" }).trim() || null;
  } catch {
    return null;
  }
}

const engines = [];
const soffice = which("soffice") ?? which("libreoffice");
if (soffice) engines.push({ id: "lo", label: `LibreOffice+H2Orestart (${soffice})` });
if (process.env.HWP_RENDER_CMD) engines.push({ id: "custom", label: `custom: ${process.env.HWP_RENDER_CMD}` });
if (engines.length === 0) {
  console.error("사용 가능한 렌더러가 없습니다. LibreOffice(+H2Orestart)를 설치하거나 HWP_RENDER_CMD를 지정하세요.");
  process.exit(1);
}
const pdftoppm = which("pdftoppm");

const samples = readdirSync(samplesDir)
  .filter((f) => /\.(hwp|hwpx)$/i.test(f))
  .sort();
if (samples.length === 0) {
  console.error(`샘플이 없습니다: ${samplesDir} (*.hwp, *.hwpx)`);
  process.exit(1);
}
console.log(`샘플 ${samples.length}건, 엔진 ${engines.map((e) => e.id).join(", ")}`);

function convertWithLo(input, engineOutDir) {
  execFileSync(soffice, ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", engineOutDir, input], {
    stdio: "pipe",
    timeout: 120_000,
  });
  const pdf = join(engineOutDir, basename(input).replace(extname(input), ".pdf"));
  return existsSync(pdf) ? pdf : null;
}

function convertWithCustom(input, engineOutDir) {
  const cmd = process.env.HWP_RENDER_CMD.replaceAll("{in}", JSON.stringify(input)).replaceAll(
    "{outdir}",
    JSON.stringify(engineOutDir),
  );
  execSync(cmd, { stdio: "pipe", timeout: 180_000, shell: "/bin/sh" });
  const pdf = join(engineOutDir, basename(input).replace(extname(input), ".pdf"));
  return existsSync(pdf) ? pdf : null;
}

function thumbnails(pdf, thumbDir, stem) {
  if (!pdftoppm) return [];
  mkdirSync(thumbDir, { recursive: true });
  try {
    execFileSync(pdftoppm, ["-png", "-r", "110", "-f", "1", "-l", "2", pdf, join(thumbDir, stem)], {
      stdio: "pipe",
      timeout: 60_000,
    });
    return readdirSync(thumbDir)
      .filter((f) => f.startsWith(stem) && f.endsWith(".png"))
      .sort()
      .map((f) => join(thumbDir, f));
  } catch {
    return [];
  }
}

const results = [];
for (const sample of samples) {
  const input = join(samplesDir, sample);
  const stem = sample.replace(/\.[^.]+$/, "").replace(/[^\w가-힣-]+/g, "_");
  for (const engine of engines) {
    const engineOutDir = join(outDir, engine.id, stem);
    mkdirSync(engineOutDir, { recursive: true });
    const startedAt = Date.now();
    let pdf = null;
    let error = null;
    try {
      pdf = engine.id === "lo" ? convertWithLo(input, engineOutDir) : convertWithCustom(input, engineOutDir);
    } catch (err) {
      error = String(err?.message ?? err).slice(0, 300);
    }
    const elapsedMs = Date.now() - startedAt;
    const thumbs = pdf ? thumbnails(pdf, join(engineOutDir, "thumbs"), stem) : [];
    results.push({
      sample,
      bytes: statSync(input).size,
      engine: engine.id,
      ok: Boolean(pdf),
      pdf: pdf ? pdf.replace(outDir + "/", "") : null,
      thumbs: thumbs.map((t) => t.replace(outDir + "/", "")),
      elapsedMs,
      error,
    });
    console.log(`${engine.id.padEnd(7)} ${pdf ? "OK " : "FAIL"} ${Math.round(elapsedMs / 100) / 10}s  ${sample}`);
  }
}

const byEngine = {};
for (const engine of engines) {
  const rows = results.filter((r) => r.engine === engine.id);
  byEngine[engine.id] = {
    label: engine.label,
    total: rows.length,
    ok: rows.filter((r) => r.ok).length,
    successRate: Math.round((rows.filter((r) => r.ok).length / rows.length) * 1000) / 10,
  };
}
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), byEngine, results }, null, 2));

const csvHeader = "sample,engine,render_ok,table_score(0-2),layout_score(0-2),blank_visible(0-1),notes";
const csvRows = results.map((r) => `"${r.sample}",${r.engine},${r.ok ? 1 : 0},,,,`);
writeFileSync(join(outDir, "scores.csv"), [csvHeader, ...csvRows].join("\n"));

const grouped = new Map();
for (const r of results) {
  if (!grouped.has(r.sample)) grouped.set(r.sample, []);
  grouped.get(r.sample).push(r);
}
const rowsHtml = [...grouped.entries()]
  .map(([sample, rs]) => {
    const cells = rs
      .map(
        (r) => `<td style="vertical-align:top;padding:8px;border:1px solid #ddd">
          <div><b>${r.engine}</b> — ${r.ok ? `성공 (${Math.round(r.elapsedMs / 100) / 10}s)` : `<span style="color:#a00">실패</span>`}</div>
          ${r.error ? `<div style="color:#a00;font-size:12px">${r.error}</div>` : ""}
          ${r.pdf ? `<div><a href="${r.pdf}">PDF 열기</a></div>` : ""}
          <div>${r.thumbs.map((t) => `<img src="${t}" style="width:220px;border:1px solid #ccc;margin:4px 4px 0 0">`).join("")}</div>
        </td>`,
      )
      .join("");
    return `<tr><td style="vertical-align:top;padding:8px;border:1px solid #ddd;max-width:220px"><b>${sample}</b></td>${cells}</tr>`;
  })
  .join("\n");
const summaryHtml = Object.entries(byEngine)
  .map(([id, s]) => `<li><b>${id}</b> (${s.label}): ${s.ok}/${s.total} 성공 — ${s.successRate}%</li>`)
  .join("");
writeFileSync(
  join(outDir, "report.html"),
  `<!doctype html><meta charset="utf-8"><title>Gate 0 HWP 렌더링 스파이크</title>
<body style="font-family:sans-serif;margin:24px">
<h1>Gate 0 HWP 렌더링 스파이크</h1>
<p>${new Date().toISOString()} · 샘플 ${samples.length}건 · 통과 기준: 성공률 90% 이상 + 표 보존</p>
<ul>${summaryHtml}</ul>
<p>채점은 <code>scores.csv</code>에 기록하세요 (table/layout/blank 항목은 육안 채점).</p>
<table style="border-collapse:collapse">${rowsHtml}</table>
</body>`,
);

console.log(`\n완료: ${outDir}/report.html · scores.csv · summary.json`);
for (const [id, s] of Object.entries(byEngine)) console.log(`  ${id}: ${s.ok}/${s.total} (${s.successRate}%)`);

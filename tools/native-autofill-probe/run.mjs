import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const root = resolve(new URL('../..', import.meta.url).pathname);
const [sourceArg, analysisArg] = process.argv.slice(2);
if (!sourceArg || !analysisArg) throw Error('Usage: node tools/native-autofill-probe/run.mjs source.hwpx analysis.json');
const sourcePath = resolve(sourceArg), analysisPath = resolve(analysisArg);
const out = join(root, 'docs/evidence/native-autofill-20261001', new Date().toISOString().replace(/[:.]/g, '-'));
const work = mkdtempSync(join(tmpdir(), 'native-autofill-'));
const exec = promisify(execFile), session = 'native-autofill-' + process.pid;
const req = createRequire(join(root, 'apps/web/package.json'));
const esbuild = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'))('esbuild');
const { parse } = req('kordoc');
const wasmPath = join(dirname(req.resolve('@rhwp/core')), 'rhwp_bg.wasm');
const browser = async (args) => (await exec('agent-browser', ['--session', session, ...args], { timeout: 30000, maxBuffer: 20e6 })).stdout;
const evaluate = async code => JSON.parse(await browser(['eval', code]));
const report = { boundary: 'Actual Studio SDK/protocol/transaction with local source and synthetic profile. No product UI, model, database or materialization success claimed.', ok: false };
let server;
try {
  await exec('pnpm', ['exec', 'tsx', '--tsconfig', 'apps/web/tsconfig.json', 'tools/native-autofill-probe/prepare.ts', sourcePath, analysisPath, join(work, 'input.json')], { cwd: root });
  await esbuild.build({ entryPoints: [join(root, 'tools/native-autofill-probe/entry.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: join(work, 'probe.js'), tsconfig: join(root, 'apps/web/tsconfig.json'), nodePaths: [join(root, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_RHWP_STUDIO_URL': 'undefined' } });
  server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/rhwp_bg.wasm') { response.setHeader('content-type', 'application/wasm'); response.end(readFileSync(wasmPath)); }
    else if (path === '/source.hwpx') { response.setHeader('content-type', 'application/octet-stream'); response.end(readFileSync(sourcePath)); }
    else if (path === '/input.json' || path === '/probe.js') { response.setHeader('content-type', path.endsWith('json') ? 'application/json' : 'text/javascript'); response.end(readFileSync(join(work, path.slice(1)))); }
    else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><p>로컬 실제 Studio 엔진 검증 · 운영 작성화면 아님</p><p id="status">starting</p><div id="editor" style="height:800px"></div><script src="/probe.js"></script></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mkdirSync(out, { recursive: true });
  await browser(['open', 'http://127.0.0.1:' + server.address().port]);
  for (let turn = 0; turn < 80; turn++) {
    const state = await evaluate('window.autofillAudit?.state ?? "loading"');
    if (state === 'passed' || state === 'failed') break;
    await browser(['wait', '500']);
  }
  const audit = await evaluate('window.autofillAudit');
  if (!audit) throw Error('No actual engine probe result');
  const beforeBytes = audit.beforeBytes && new Uint8Array(audit.beforeBytes);
  const afterBytes = audit.afterBytes && new Uint8Array(audit.afterBytes);
  delete audit.beforeBytes; delete audit.afterBytes;
  report.audit = audit;
  if (audit.state !== 'passed') throw Error(audit.error ?? 'Actual Studio did not finish before bounded deadline');
  const before = (await parse(beforeBytes)).blocks, after = (await parse(afterBytes)).blocks;
  const changes = [];
  let comparedCells = 0;
  for (let b = 0; b < before.length; b++) for (let r = 0; r < (before[b].table?.cells.length ?? 0); r++) for (let c = 0; c < before[b].table.cells[r].length; c++) {
    comparedCells++;
    const beforeCell = before[b].table.cells[r][c], afterCell = after[b]?.table?.cells[r]?.[c];
    if (JSON.stringify(beforeCell) !== JSON.stringify(afterCell)) changes.push({ block: b, row: r, col: c, before: beforeCell, after: afterCell });
  }
  const input = JSON.parse(readFileSync(join(work, 'input.json'), 'utf8'));
  for (const change of changes) {
    const allowed = audit.applied.some(entry => {
      const field = input.fields.find(field => field.fieldId === entry.fieldId);
      const position = field.position;
      const label = before[position.blockIndex]?.table?.cells[position.row]?.[position.col];
      return change.block === position.blockIndex && change.row === position.row && change.col === position.col + label.colSpan && change.after.text === entry.value;
    });
    if (!allowed) throw Error('Change outside normal field value cell: ' + JSON.stringify(change));
  }
  if (changes.length !== audit.applied.length) throw Error('Changed cells do not equal applied normal entries');
  report.comparedCells = comparedCells; report.changes = changes;
  report.resultSha256 = createHash('sha256').update(afterBytes).digest('hex');
  report.ok = true;
} catch (error) { report.error = String(error); }
finally {
  mkdirSync(out, { recursive: true });
  report.cleanup = { browserSessionClosed: false, finiteServerClosed: !server, temporaryBundleRemoved: false };
  await browser(['close']).then(() => { report.cleanup.browserSessionClosed = true; }).catch(() => {});
  if (server) { await new Promise(resolve => server.close(resolve)); report.cleanup.finiteServerClosed = true; }
  rmSync(work, { recursive: true, force: true });
  report.cleanup.temporaryBundleRemoved = true;
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ok: report.ok, error: report.error, out }));
if (!report.ok) process.exitCode = 1;

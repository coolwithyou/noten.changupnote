import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const runRoot = mkdtempSync(join(tmpdir(), "cunote-confirmation-sheet-browser-"));
const outputPath = join(runRoot, "bundle.js");
const session = `cunote-confirmation-sheet-${process.pid}`;
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("tsx/package.json"))("esbuild");

function browser(args, input) {
  const result = spawnSync("agent-browser", ["--session", session, ...args], {
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

try {
  esbuild.buildSync({
    entryPoints: [join(workspaceRoot, "tools/product-uat/confirmation-sheet-browser-entry.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: outputPath,
    tsconfig: join(workspaceRoot, "apps/web/tsconfig.json"),
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    nodePaths: [join(workspaceRoot, "apps/web/node_modules")],
  });
  browser(["open", "about:blank"]);
  browser(["eval", "--stdin"], readFileSync(outputPath, "utf8"));
  const rawResult = JSON.parse(browser(["eval", "--stdin"], `(async () => {
    const audit = window.confirmationSheetAudit;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (check, message) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (check()) return;
        await wait(10);
      }
      throw new Error(message);
    };
    const buttons = () => [...document.querySelectorAll('button')];
    const button = label => buttons().find(item => item.textContent?.trim() === label);
    const pressed = label => button(label)?.getAttribute('aria-pressed') === 'true';
    const writable = () => Boolean(button('저장')) && ['예', '아니오', '확인할 수 없음'].every(label => !button(label)?.disabled);
    const readOnly = () => document.body.textContent.includes('조회 전용 권한이에요')
      && ['예', '아니오', '확인할 수 없음'].every(label => button(label)?.disabled)
      && !button('저장');

    await until(readOnly, 'viewer GET은 읽기 전용으로 렌더돼야 한다');
    if (!pressed('예')) throw new Error('viewer도 기존 답변을 읽어야 한다');

    audit.setGet('a', {canSubmit:true, delayMs:0, persistedValue:'yes'});
    audit.setOpen(false); await wait(20); audit.setOpen(true);
    await until(writable, 'owner 재조회는 편집을 열어야 한다');
    if (!pressed('예')) throw new Error('owner 재조회도 기존 답변을 복원해야 한다');

    audit.setPutMode('forbidden');
    button('아니오').click(); await wait(10); button('저장').click();
    await until(() => document.body.textContent.includes('변경 내용은 저장되지 않았어요'), '403은 미저장 안내로 전환해야 한다');
    if (!pressed('예') || pressed('아니오')) throw new Error('403 뒤 마지막 GET 답변으로 복원해야 한다');
    if (audit.requests.filter(request => request.method === 'PUT').length !== 1) throw new Error('403 뒤 자동 재전송하면 안 된다');

    audit.setGet('a', {canSubmit:true, delayMs:0, persistedValue:'yes'});
    button('권한 다시 확인').click();
    await until(writable, '수동 권한 재확인은 편집 권한을 다시 읽어야 한다');
    audit.setPutMode('pending_forbidden');
    button('아니오').click(); await wait(10); button('저장').click();
    await until(() => audit.pendingPutCount() === 1, '지연 PUT이 있어야 한다');
    audit.setGet('b', {canSubmit:false, delayMs:0, persistedValue:'unknown'});
    audit.setCompany('b'); await until(readOnly, 'B viewer scope를 읽어야 한다');
    audit.setGet('a', {canSubmit:true, delayMs:0, persistedValue:'yes'});
    audit.setCompany('a'); await until(writable, 'A 새 세대는 다시 writable이어야 한다');
    audit.releasePendingPuts(); await wait(30);
    if (!writable() || document.body.textContent.includes('변경 내용은 저장되지 않았어요')) {
      throw new Error('A→B→A 뒤 오래된 403이 현재 scope를 잠그면 안 된다');
    }

    audit.setOpen(false); await wait(20);
    audit.setGet('a', {canSubmit:true, delayMs:0, persistedValue:'yes', pending:true});
    audit.setOpen(true);
    await until(() => audit.pendingGetCount() > 0, '닫기 전 GET 요청이 실제 시작돼야 한다');
    audit.setOpen(false); await wait(10);
    audit.setGet('a', {canSubmit:false, delayMs:0, persistedValue:'unknown'});
    audit.setOpen(true);
    await until(readOnly, '닫기·재열기의 최신 GET은 read-only여야 한다');
    audit.releasePendingGets(); await wait(30);
    if (!readOnly() || !pressed('확인할 수 없음')) throw new Error('닫기 전 오래된 writable GET을 폐기해야 한다');

    audit.setGet('b', {canSubmit:false, delayMs:0, persistedValue:'no'});
    audit.setCompany('b');
    await until(() => document.body.textContent.includes('확인 질문 b') && pressed('아니오') && readOnly(), 'ABA 준비용 B scope를 읽어야 한다');
    audit.setGet('a', {canSubmit:true, delayMs:0, persistedValue:'yes', pending:true});
    audit.setCompany('a');
    await until(() => audit.pendingGetCount() > 0, 'ABA의 오래된 A GET이 실제 시작돼야 한다');
    audit.setCompany('b'); await until(() => pressed('아니오') && readOnly(), 'ABA 중간 B 응답을 읽어야 한다');
    audit.setGet('a', {canSubmit:false, delayMs:0, persistedValue:'unknown'});
    audit.setCompany('a'); await until(() => pressed('확인할 수 없음') && readOnly(), 'ABA의 최신 A 응답을 읽어야 한다');
    audit.releasePendingGets(); await wait(30);
    if (!readOnly() || !pressed('확인할 수 없음')) throw new Error('A→B→A 뒤 오래된 writable GET을 폐기해야 한다');

    return JSON.stringify({
      ok: true,
      suite: 'confirmation-sheet-browser',
      checks: ['viewer_read_only', 'persisted_answer_visible', '403_restore', 'no_retry_storm', 'aba_stale_403', 'close_reopen_stale_get', 'aba_stale_get'],
      getCount: audit.requests.filter(request => request.method === 'GET').length,
      putCount: audit.requests.filter(request => request.method === 'PUT').length,
      externalWrites: 0,
    });
  })()`));
  const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
  assert.equal(result.ok, true);
  console.log(JSON.stringify(result));
} finally {
  try { browser(["close"]); } catch {}
  rmSync(runRoot, { recursive: true, force: true });
}

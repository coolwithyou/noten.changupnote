import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const runRoot = mkdtempSync(join(tmpdir(), "cunote-inline-confirmation-browser-"));
const outputPath = join(runRoot, "bundle.js");
const session = `cunote-inline-confirmation-${process.pid}`;
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
    entryPoints: [join(workspaceRoot, "tools/product-uat/inline-grant-confirmation-browser-entry.tsx")],
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
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (check, message) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (check()) return;
        await wait(10);
      }
      throw new Error(message);
    };
    const button = label => [...document.querySelectorAll('button')]
      .find(item => item.textContent?.trim() === label);

    await until(() => button('네, 가능해요'), '인라인 질문 선택지가 보여야 한다');
    button('네, 가능해요').click();
    await until(
      () => document.body.textContent.includes('확인된 지원 조건에 맞아요.'),
      '저장 직후 같은 카드에서 최신 판정이 보여야 한다',
    );
    if (window.inlineGrantAudit.savedResults.length !== 0) {
      throw new Error('결과를 읽기 전에 부모 목록을 재정렬하면 안 된다');
    }
    if (!document.body.textContent.includes('같은 회사 정보를 쓰는 공고 4건도 함께 다시 확인했어요.')) {
      throw new Error('한 답변이 갱신한 관련 공고 수를 같은 카드에서 알려야 한다');
    }
    const put = window.inlineGrantAudit.requests.find(request => request.method === 'PUT');
    if (put?.body?.answers?.[0]?.questionId !== 'question-location') {
      throw new Error('화면에 표시한 exact 질문 ID로 답변해야 한다');
    }
    if (!document.activeElement?.textContent?.includes('확인된 지원 조건에 맞아요.')) {
      throw new Error('저장 뒤 결과 영역으로 키보드 포커스를 옮겨야 한다');
    }
    button('신청 준비하기').click();
    await until(() => window.inlineGrantAudit.savedResults.length === 1, '명시적 행동 뒤 최신 결과를 부모에 전달해야 한다');
    if (window.inlineGrantAudit.preparedGrantIds[0] !== 'audit-grant') {
      throw new Error('지원 가능 결과는 같은 카드에서 신청 준비 행동으로 이어져야 한다');
    }

    return JSON.stringify({
      ok: true,
      suite: 'inline-grant-confirmation-browser',
      checks: ['exact_question_submit', 'same_card_outcome', 'related_grant_count', 'result_focus', 'deferred_reorder', 'direct_prepare'],
      putCount: window.inlineGrantAudit.requests.filter(request => request.method === 'PUT').length,
      externalWrites: 0,
    });
  })()`));
  const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
  assert.equal(result.ok, true);
  assert.equal(result.putCount, 1);
  console.log(JSON.stringify(result));
} finally {
  try { browser(["close"]); } catch {}
  rmSync(runRoot, { recursive: true, force: true });
}

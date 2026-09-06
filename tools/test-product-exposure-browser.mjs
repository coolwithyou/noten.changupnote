import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const session = `cunote-exposure-${process.pid}`;
function browser(args, input) {
  const result = spawnSync("agent-browser", ["--session", session, ...args], { input, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
const source = ts.transpileModule(readFileSync("apps/web/src/lib/client/productCardExposure.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace("export function observeProductCards", "function observeProductCards");
try {
  browser(["open", "about:blank"]);
  const result = browser(["eval", "--stdin"], `(async () => {
    ${source}
    const pause = () => new Promise(resolve => setTimeout(resolve, 750));
    const assert = (value, message) => { if (!value) throw new Error(message); };
    document.body.innerHTML = '<main id="root"><div style="height:2000px"></div><article data-product-grant="a" style="height:100px">공고 A</article><div style="height:1500px"></div></main>';
    const requests = [];
    window.fetch = async (url, options) => { requests.push({url, body: JSON.parse(options.body)}); return new Response(null, {status:204}); };
    const root = document.getElementById('root');
    const stop = observeProductCards(root, new Map([['a','signed-a'],['b','signed-b']]), 'company-a');
    await pause(); assert(requests.length === 0, '화면 밖 카드는 노출이 아니다');
    root.querySelector('article').scrollIntoView(); await pause();
    assert(requests.length === 1, '화면에 들어온 카드를 기록한다');
    assert(requests[0].body.companyId === 'company-a' && requests[0].body.token === 'signed-a', '정확한 회사와 서버 영수증을 전송한다');
    window.scrollTo(0,0); await pause(); root.querySelector('article').scrollIntoView(); await pause();
    assert(requests.length === 1, '같은 영수증을 재전송하지 않는다');
    const added = document.createElement('article'); added.dataset.productGrant='b'; added.style.height='100px'; added.textContent='공고 B'; root.append(added);
    added.scrollIntoView(); await pause(); assert(requests.length === 2, '접힘 목록이 열린 뒤 추가된 카드도 관측한다');
    stop(); window.scrollTo(0,0); await pause(); added.scrollIntoView(); await pause();
    assert(requests.length === 2, 'cleanup 이후 신호가 없다');
    return {ok:true, suite:'product-exposure-browser', requests:requests.length, externalWrites:0};
  })()`);
  console.log(result);
} finally {
  browser(["close"]);
}

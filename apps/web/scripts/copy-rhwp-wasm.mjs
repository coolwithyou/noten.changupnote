// @rhwp/core의 WASM을 public/으로 복사한다.
// 6.9MB 바이너리를 git에 넣지 않기 위해 dev/build 시점에 node_modules에서 동기화한다.
import { copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(appRoot, "node_modules/@rhwp/core/rhwp_bg.wasm");
const dest = resolve(appRoot, "public/rhwp_bg.wasm");

if (!existsSync(src)) {
  console.error(`[copy-rhwp-wasm] 원본 없음: ${src} — pnpm install 후 다시 시도하세요`);
  process.exit(1);
}
if (!existsSync(dest) || statSync(src).size !== statSync(dest).size) {
  copyFileSync(src, dest);
  console.log(`[copy-rhwp-wasm] 복사 완료 → public/rhwp_bg.wasm (${statSync(dest).size}B)`);
}

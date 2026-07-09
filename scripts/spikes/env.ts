// Apply Experience v2 Phase 0 스파이크 전용 env 로더.
// 이 worktree 규약: 루트 .env.local → .env 순으로 로드(먼저 정의된 값 우선).
// (apps/web/src/lib/server/loadMonorepoEnv.ts 패턴 참조)
// 시크릿 값은 절대 출력하지 않는다.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/spikes
const repoRoot = resolve(here, "..", ".."); // repo root

export function loadEnv(): void {
  const candidates = [resolve(repoRoot, ".env.local"), resolve(repoRoot, ".env")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      if (!rawKey) continue;
      const key = rawKey.trim();
      if (process.env[key] !== undefined) continue;
      let value = rest.join("=").trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

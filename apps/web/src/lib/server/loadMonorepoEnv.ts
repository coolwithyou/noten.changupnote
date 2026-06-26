import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadMonorepoEnv() {
  const candidates = [
    resolve(/*turbopackIgnore: true*/ process.cwd(), ".env.local"),
    resolve(/*turbopackIgnore: true*/ process.cwd(), ".env"),
    resolve(/*turbopackIgnore: true*/ process.cwd(), "../..", ".env.local"),
    resolve(/*turbopackIgnore: true*/ process.cwd(), "../..", ".env"),
  ];

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

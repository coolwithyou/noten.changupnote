export function loadMonorepoEnv() {
  // CLI 전용 편의 로더가 Next 서버 번들에 정적으로 포함되더라도 NFT가 가변 fs 경로를
  // "프로젝트 전체 필요"로 오인하지 않게 builtin 모듈을 런타임에만 해석한다.
  const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { join } = process.getBuiltinModule("node:path");
  const candidates = [
    join(process.cwd(), ".env.local"),
    join(process.cwd(), ".env"),
    join(process.cwd(), "../..", ".env.local"),
    join(process.cwd(), "../..", ".env"),
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

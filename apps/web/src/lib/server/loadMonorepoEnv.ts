export function loadMonorepoEnv() {
  // CLI 전용 편의 로더가 Next 서버 번들에 정적으로 포함되더라도 NFT가 가변 fs 경로를
  // "프로젝트 전체 필요"로 오인하지 않게 builtin 모듈을 런타임에만 해석한다.
  const { join } = process.getBuiltinModule("node:path");
  const candidates = [
    join(process.cwd(), ".env.local"),
    join(process.cwd(), ".env"),
    join(process.cwd(), "../..", ".env.local"),
    join(process.cwd(), "../..", ".env"),
  ];

  loadEnvFiles(candidates);
}

/**
 * 로컬 analysis-lab CLI 전용 환경 로더.
 *
 * Next 개발 서버는 apps/web/.env.development.local 을 자동으로 읽지만 모노레포
 * 루트에서 실행하는 `pnpm lab:*` CLI는 읽지 않는다. 분석 CLI가 조용히 루트 .env의
 * API 키 경로로 갈라지지 않도록 같은 로컬 설정을 먼저 읽고, 일반 모노레포 env를
 * 나중에 보충한다. 이미 셸에 명시한 값은 어떤 파일도 덮어쓰지 않는다.
 */
export function loadAnalysisLabEnv() {
  const { join } = process.getBuiltinModule("node:path");
  const cwd = process.cwd();
  loadEnvFiles([
    join(cwd, "apps/web/.env.development.local"),
    join(cwd, "apps/web/.env.local"),
    join(cwd, ".env.development.local"),
    join(cwd, ".env.local"),
    join(cwd, ".env"),
    join(cwd, "../..", ".env.development.local"),
    join(cwd, "../..", ".env.local"),
    join(cwd, "../..", ".env"),
  ]);
}

function loadEnvFiles(candidates: string[]) {
  const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");
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

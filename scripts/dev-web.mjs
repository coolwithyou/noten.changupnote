import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const webPort = resolveWebPort(process.env.CUNOTE_WEB_PORT);
const localUrl = `http://127.0.0.1:${webPort}`;
const tunnelUrl = "https://dev.changupnote.com";
const tunnelName = "changupnote-dev";
const tunnelConfig = resolve(homedir(), ".cloudflared", "changupnote-dev.yml");
const tunnelCommand = `cloudflared tunnel --config ${tunnelConfig} run`;

loadDevEnv();
buildWorkspacePackages();

const rawArgs = process.argv.slice(2);
const tunnelDisabled =
  rawArgs.includes("--no-tunnel") ||
  ["0", "false", "no", "off"].includes(
    (process.env.CUNOTE_DEV_TUNNEL ?? "").trim().toLowerCase(),
  );
const forwardedArgs = rawArgs.filter((arg) => arg !== "--no-tunnel");

const repositoryAdapter = process.env.CUNOTE_REPOSITORY_ADAPTER ??
  (hasDatabaseUrl() ? "drizzle" : undefined);

console.log(
  [
    "",
    "창업노트 웹 개발 서버",
    `- 로컬 접속: ${localUrl}`,
    `- HTTPS 접속: ${tunnelUrl}`,
    `- 데이터 어댑터: ${repositoryAdapter ?? "runtime"}`,
    `- Cloudflare 터널: ${tunnelDisabled ? "비활성(--no-tunnel)" : "자동 기동"}`,
    "",
  ].join("\n"),
);

let shuttingDown = false;

const pnpmArgs = [
  "--filter",
  "@cunote/web",
  "exec",
  "next",
  "dev",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(webPort),
];
if (forwardedArgs.length > 0) {
  pnpmArgs.push(...forwardedArgs);
}

const webChild = spawn("pnpm", pnpmArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(repositoryAdapter ? { CUNOTE_REPOSITORY_ADAPTER: repositoryAdapter } : {}),
    NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? tunnelUrl,
  },
});

const tunnelChild = tunnelDisabled ? undefined : startTunnel();

webChild.on("error", (error) => {
  console.error(`웹 개발 서버를 실행하지 못했습니다: ${error.message}`);
  shutdown("SIGTERM");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

webChild.on("exit", (code, signal) => {
  shuttingDown = true;
  tunnelChild?.kill("SIGTERM");

  if (signal) {
    const signalExitCodes = {
      SIGINT: 130,
      SIGTERM: 143,
    };

    process.exit(signalExitCodes[signal] ?? 128);
  }

  process.exit(code ?? 0);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  webChild.kill(signal);
  tunnelChild?.kill(signal);
}

function startTunnel() {
  if (!commandExists("cloudflared")) {
    console.warn(
      `[tunnel] cloudflared가 설치돼 있지 않아 HTTPS 터널을 건너뜁니다. 로컬 ${localUrl}만 사용하거나 \`brew install cloudflared\` 후 다시 실행하세요.`,
    );
    return undefined;
  }

  if (!existsSync(tunnelConfig)) {
    console.warn(`[tunnel] 설정 파일이 없어 터널을 건너뜁니다: ${tunnelConfig}`);
    return undefined;
  }

  if (isTunnelAlreadyRunning()) {
    console.log(
      `[tunnel] ${tunnelName} 커넥터가 이미 실행 중이라 새로 띄우지 않습니다. (${tunnelUrl})`,
    );
    return undefined;
  }

  const child = spawn(
    "cloudflared",
    ["tunnel", "--config", tunnelConfig, "run"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  prefixStream(child.stdout, "[tunnel] ");
  prefixStream(child.stderr, "[tunnel] ");

  child.on("error", (error) => {
    console.warn(
      `[tunnel] 터널 실행 실패(로컬 서버는 계속 동작): ${error.message}`,
    );
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.warn(
      `[tunnel] 터널이 종료됐습니다(code=${code ?? ""} signal=${signal ?? ""}). ` +
        `${tunnelUrl} 접속은 끊기지만 로컬 ${localUrl}는 계속 동작합니다. ` +
        `수동 재기동: ${tunnelCommand}`,
    );
  });

  return child;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error;
}

function isTunnelAlreadyRunning() {
  if (process.platform === "win32") return false;
  const result = spawnSync("pgrep", ["-f", `cloudflared.*${tunnelName}`], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function prefixStream(stream, prefix) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${prefix}${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      process.stdout.write(`${prefix}${buffer}\n`);
    }
  });
}

function loadDevEnv() {
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "apps/web/.env.local"),
    resolve(process.cwd(), "apps/web/.env"),
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

function hasDatabaseUrl() {
  return Boolean(
    process.env.DATABASE_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    process.env.DIRECT_URL?.trim(),
  );
}

function resolveWebPort(raw) {
  if (!raw?.trim()) return 4010;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`CUNOTE_WEB_PORT가 올바른 포트가 아닙니다: ${raw}`);
  }
  return parsed;
}

function buildWorkspacePackages() {
  console.log("[packages] 현재 소스 기준으로 contracts/core 런타임을 빌드합니다.");
  const build = spawnSync("pnpm", ["build:packages"], { stdio: "inherit" });
  if (build.error) {
    console.error(`[packages] 워크스페이스 패키지를 빌드하지 못했습니다: ${build.error.message}`);
    process.exit(1);
  }
  if (build.status !== 0) {
    console.error(`[packages] 워크스페이스 패키지 빌드가 실패했습니다(code=${build.status ?? "unknown"}).`);
    process.exit(build.status ?? 1);
  }

  const verification = spawnSync("pnpm", ["verify:package-runtime-freshness"], { stdio: "inherit" });
  if (verification.error || verification.status !== 0) {
    console.error("[packages] 빌드 산출물 검증이 실패했습니다.");
    process.exit(verification.status ?? 1);
  }
}

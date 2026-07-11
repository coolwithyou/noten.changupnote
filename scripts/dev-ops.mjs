import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const localUrl = "http://127.0.0.1:4011";
const tunnelUrl = "https://dev-ops.changupnote.com";
const tunnelName = "changupnote-dev";
const tunnelConfig = resolve(homedir(), ".cloudflared", "changupnote-dev.yml");
const tunnelCommand = `cloudflared tunnel --config ${tunnelConfig} run`;

loadDevEnv();

const rawArgs = process.argv.slice(2);
const tunnelDisabled =
  rawArgs.includes("--no-tunnel") ||
  ["0", "false", "no", "off"].includes(
    (process.env.CUNOTE_DEV_TUNNEL ?? "").trim().toLowerCase(),
  );
const forwardedArgs = rawArgs.filter((arg) => arg !== "--no-tunnel");

console.log(
  [
    "",
    "창업노트 어드민(ops) 개발 서버",
    `- 로컬 접속: ${localUrl}`,
    `- HTTPS 접속: ${tunnelUrl}`,
    `- Cloudflare 터널: ${tunnelDisabled ? "비활성(--no-tunnel)" : "자동 기동(웹 서버와 공유)"}`,
    "",
  ].join("\n"),
);

let shuttingDown = false;

const pnpmArgs = ["--filter", "@cunote/admin", "dev"];
if (forwardedArgs.length > 0) {
  pnpmArgs.push("--", ...forwardedArgs);
}

const adminChild = spawn("pnpm", pnpmArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    // 루트 .env.local의 NEXTAUTH_URL은 웹 앱(dev.changupnote.com) 값이라 여기서 신뢰하지 않는다.
    // admin 전용 ADMIN_AUTH_URL이 없으면 ops 터널 URL을 쓴다.
    NEXTAUTH_URL: process.env.ADMIN_AUTH_URL ?? tunnelUrl,
  },
});

const tunnelChild = tunnelDisabled ? undefined : startTunnel();

adminChild.on("error", (error) => {
  console.error(`어드민 개발 서버를 실행하지 못했습니다: ${error.message}`);
  shutdown("SIGTERM");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

adminChild.on("exit", (code, signal) => {
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
  adminChild.kill(signal);
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
    resolve(process.cwd(), "apps/admin/.env.local"),
    resolve(process.cwd(), "apps/admin/.env"),
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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localUrl = "http://127.0.0.1:4010";
const tunnelUrl = "https://dev.changupnote.com";
const tunnelCommand =
  "cloudflared tunnel --config ~/.cloudflared/changupnote-dev.yml run";

loadDevEnv();

console.log(
  [
    "",
    "창업노트 웹 개발 서버",
    `- 로컬 접속: ${localUrl}`,
    `- HTTPS 접속: ${tunnelUrl}`,
    "",
    "Cloudflare tunnel이 실행 중이면 위 HTTPS 주소로 접속하면 됩니다.",
    `터널 실행: ${tunnelCommand}`,
    "",
  ].join("\n"),
);

const forwardedArgs = process.argv.slice(2);
const pnpmArgs = ["--filter", "@cunote/web", "dev"];

if (forwardedArgs.length > 0) {
  pnpmArgs.push("--", ...forwardedArgs);
}

const child = spawn("pnpm", pnpmArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? tunnelUrl,
  },
});

child.on("error", (error) => {
  console.error(`웹 개발 서버를 실행하지 못했습니다: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    const signalExitCodes = {
      SIGINT: 130,
      SIGTERM: 143,
    };

    process.exit(signalExitCodes[signal] ?? 128);
  }

  process.exit(code ?? 0);
});

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

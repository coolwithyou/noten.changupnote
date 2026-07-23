import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAdminSql, getAdminSql } from "@/lib/server/db/client";
import { hashPassword, normalizeEmail, validateAdminEmail, validateAdminPassword } from "@/lib/server/auth/password";
import { isAllowedAdminEmail } from "@/lib/server/auth/adminUsers";

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

async function main() {
  const email = normalizeEmail(requiredArg("email"));
  const name = args.name ?? null;
  const role = args.role ?? "admin";
  if (process.argv.slice(2).some((value) => value === "--password" || value.startsWith("--password="))) {
    throw new Error("--password argv 입력은 프로세스 목록에 노출됩니다. 숨김 프롬프트나 --google-only를 사용하세요.");
  }
  const googleOnly = process.argv.includes("--google-only");
  const generatePassword = process.argv.includes("--generate-password");
  if (googleOnly && generatePassword) throw new Error("--google-only와 --generate-password는 함께 사용할 수 없습니다.");
  const password = googleOnly
    ? null
    : generatePassword
      ? randomBytes(24).toString("base64url")
      : await readPasswordHidden();

  if (!validateAdminEmail(email)) throw new Error("올바른 이메일을 입력하세요.");
  if (!isAllowedAdminEmail(email)) {
    throw new Error(`${email}이 ADMIN_ALLOWED_EMAILS 허용 목록에 없습니다.`);
  }
  if (!process.env.ADMIN_ALLOWED_EMAILS && !process.env.CUNOTE_ADMIN_EMAILS) {
    console.warn("경고: ADMIN_ALLOWED_EMAILS가 비어 있어 활성 admin_users 전체의 로그인이 허용됩니다.");
  }
  if (password !== null && !validateAdminPassword(password)) {
    throw new Error("비밀번호는 8자 이상 200자 이하여야 합니다.");
  }
  if (!["owner", "admin", "support", "viewer", "reviewer"].includes(role)) {
    throw new Error("role은 owner/admin/support/viewer/reviewer 중 하나여야 합니다.");
  }

  const passwordHash = password === null ? null : await hashPassword(password);
  const sql = getAdminSql();
  const rows = await sql<{ id: string; email: string; role: string }[]>`
    insert into admin_users (email, name, role, password_hash, status)
    values (${email}, ${name}, ${role}, ${passwordHash}, 'active')
    on conflict (email)
    do update set
      name = excluded.name,
      role = excluded.role,
      password_hash = coalesce(excluded.password_hash, admin_users.password_hash),
      status = 'active',
      updated_at = now()
    returning id, email, role
  `;
  const user = rows[0];
  if (!user) throw new Error("운영자 계정을 생성하지 못했습니다.");
  if (generatePassword && password) {
    await appendCredentialHandoff({
      email: user.email,
      role: user.role,
      password,
    });
    await writeMemberHandoff({
      email: user.email,
      role: user.role,
      password,
    });
  }
  console.log(`admin user ready: ${user.email} (${user.role})`);
  if (generatePassword) {
    console.log("생성된 비밀번호는 spike-out/ops/review-team-credentials.md에 mode 0600으로 저장했습니다.");
    console.log(`개인 전달 문서는 ${memberHandoffRelativePath(user.email)}에 mode 0600으로 저장했습니다.`);
  }
}

async function appendCredentialHandoff(input: {
  email: string;
  role: string;
  password: string;
}): Promise<void> {
  const path = resolve(workspaceRoot, "spike-out/ops/review-team-credentials.md");
  await mkdir(dirname(path), { recursive: true });
  let exists = true;
  try {
    await stat(path);
  } catch {
    exists = false;
  }
  const handle = await open(path, "a", 0o600);
  try {
    if (!exists) {
      await handle.writeFile(
        "# 검수팀 임시 로그인 전달 문서\n\n" +
        "> Git에 커밋하지 않는다. 가능하면 Google 로그인을 사용한다. 비밀번호 전달 후 이 파일을 폐기하고, 최초 로그인 뒤 비밀번호를 회전한다.\n\n",
      );
    }
    await handle.writeFile(
      `## ${input.email}\n\n- role: ${input.role}\n- temporary password: \`${input.password}\`\n- primary login: Google (@noten.im)\n\n`,
    );
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function writeMemberHandoff(input: {
  email: string;
  role: string;
  password: string;
}): Promise<void> {
  const guidePath = resolve(workspaceRoot, "docs/guides/review-team-member-guide.md");
  const path = resolve(workspaceRoot, memberHandoffRelativePath(input.email));
  const guide = await readFile(guidePath, "utf8");
  const createdAt = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date());
  const content = [
    "# 창업노트 검수팀 개인 시작 안내",
    "",
    "> 이 문서는 본인에게만 전달합니다. 공용 채널에 올리지 말고 로그인 확인 후 운영 담당자에게 폐기를 요청하세요.",
    "",
    "## 개인 로그인 정보",
    "",
    `- 계정: \`${input.email}\``,
    `- 역할: \`${input.role}\``,
    `- 임시 비밀번호: \`${input.password}\``,
    "- 권장 로그인: **Google로 계속** (`@noten.im` 계정)",
    "- 접속 주소: https://ops.changupnote.com/review",
    `- 발급 시각: ${createdAt}`,
    "",
    "---",
    "",
    guide,
    "",
  ].join("\n");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function memberHandoffRelativePath(email: string): string {
  const safeEmail = normalizeEmail(email).replace(/[^a-z0-9._-]+/g, "-");
  return `spike-out/ops/review-team-guide-${safeEmail}.md`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAdminSql();
  });

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item?.startsWith("--")) continue;
    const equalsAt = item.indexOf("=");
    if (equalsAt > 2) {
      result[item.slice(2, equalsAt)] = item.slice(equalsAt + 1);
      continue;
    }
    const key = item.slice(2);
    const next = values[index + 1];
    if (!key || !next || next.startsWith("--")) continue;
    result[key] = next;
    index += 1;
  }
  return result;
}

function requiredArg(key: string): string {
  const value = args[key];
  if (!value) throw new Error(`--${key} 값이 필요합니다.`);
  return value;
}

async function readPasswordHidden(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    await once(process.stdin, "end");
    return input.split(/\r?\n/, 1)[0]?.trim() ?? "";
  }

  process.stdout.write("Password (입력 숨김): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      if (chunk === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        reject(new Error("비밀번호 입력이 취소됐습니다."));
        return;
      }
      if (chunk === "\r" || chunk === "\n") {
        finish();
        return;
      }
      if (chunk === "\u007f" || chunk === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };
    process.stdin.on("data", onData);
  });
}

import { closeAdminSql, getAdminSql } from "@/lib/server/db/client";
import { hashPassword, normalizeEmail, validateAdminEmail, validateAdminPassword } from "@/lib/server/auth/password";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const email = normalizeEmail(requiredArg("email"));
  const password = requiredArg("password");
  const name = args.name ?? null;
  const role = args.role ?? "admin";

  if (!validateAdminEmail(email)) throw new Error("올바른 이메일을 입력하세요.");
  if (!validateAdminPassword(password)) throw new Error("비밀번호는 8자 이상 200자 이하여야 합니다.");
  if (!["owner", "admin", "support", "viewer"].includes(role)) throw new Error("role은 owner/admin/support/viewer 중 하나여야 합니다.");

  const passwordHash = await hashPassword(password);
  const sql = getAdminSql();
  const rows = await sql<{ id: string; email: string; role: string }[]>`
    insert into admin_users (email, name, role, password_hash, status)
    values (${email}, ${name}, ${role}, ${passwordHash}, 'active')
    on conflict (email)
    do update set
      name = excluded.name,
      role = excluded.role,
      password_hash = excluded.password_hash,
      status = 'active',
      updated_at = now()
    returning id, email, role
  `;
  const user = rows[0];
  if (!user) throw new Error("운영자 계정을 생성하지 못했습니다.");
  console.log(`admin user ready: ${user.email} (${user.role})`);
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

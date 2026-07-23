import { getAdminSql } from "@/lib/server/db/client";
import { normalizeEmail, verifyPassword } from "./password";

export type AdminRole = "owner" | "admin" | "support" | "viewer" | "reviewer";
export type AdminStatus = "active" | "disabled";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  status: AdminStatus;
  passwordHash: string | null;
}

interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  status: AdminStatus;
  password_hash: string | null;
}

export async function findAdminUserByEmail(email: string): Promise<AdminUser | null> {
  const sql = getAdminSql();
  const rows = await sql<AdminUserRow[]>`
    select id, email, name, role, status, password_hash
    from admin_users
    where email = ${normalizeEmail(email)}
    limit 1
  `;
  return rows[0] ? rowToAdminUser(rows[0]) : null;
}

export async function findAdminUserById(id: string): Promise<AdminUser | null> {
  const sql = getAdminSql();
  const rows = await sql<AdminUserRow[]>`
    select id, email, name, role, status, password_hash
    from admin_users
    where id = ${id}
    limit 1
  `;
  return rows[0] ? rowToAdminUser(rows[0]) : null;
}

export async function findOrLinkGoogleAdminUser(input: {
  email: string;
  name: string | null;
  providerAccountId: string;
}): Promise<AdminUser | null> {
  const email = normalizeEmail(input.email);
  const existing = await findAdminUserByEmail(email);
  if (!existing || existing.status !== "active") return null;

  const sql = getAdminSql();
  await sql`
    update admin_users
    set name = coalesce(admin_users.name, ${input.name}), last_login_at = now(), updated_at = now()
    where id = ${existing.id}
  `;
  await sql`
    insert into admin_accounts (admin_user_id, provider, provider_account_id)
    values (${existing.id}, 'google', ${input.providerAccountId})
    on conflict (provider, provider_account_id)
    do update set admin_user_id = excluded.admin_user_id, updated_at = now()
  `;
  return { ...existing, name: existing.name ?? input.name };
}

export async function authenticateAdminPassword(email: string, password: string): Promise<AdminUser | null> {
  const user = await findAdminUserByEmail(email);
  if (!user || user.status !== "active" || !user.passwordHash) return null;
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;
  await getAdminSql()`update admin_users set last_login_at = now(), updated_at = now() where id = ${user.id}`;
  return user;
}

export function isAllowedAdminEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = normalizeEmail(email);
  const allowedEmails = splitEnv(env.ADMIN_ALLOWED_EMAILS ?? env.CUNOTE_ADMIN_EMAILS).map(normalizeEmail);
  if (allowedEmails.length === 0) return true;
  return allowedEmails.includes(normalized);
}

function rowToAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    passwordHash: row.password_hash,
  };
}

function splitEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

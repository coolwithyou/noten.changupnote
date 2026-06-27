import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface CredentialValidation {
  ok: boolean;
  email?: string;
  password?: string;
  error?: string;
}

export function validateCredentials(rawEmail: unknown, rawPassword: unknown): CredentialValidation {
  if (typeof rawEmail !== "string" || typeof rawPassword !== "string") {
    return { ok: false, error: "이메일과 비밀번호를 입력하세요." };
  }
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "올바른 이메일 형식이 아닙니다." };
  }
  if (rawPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` };
  }
  if (rawPassword.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "비밀번호가 너무 깁니다." };
  }
  return { ok: true, email, password: rawPassword };
}

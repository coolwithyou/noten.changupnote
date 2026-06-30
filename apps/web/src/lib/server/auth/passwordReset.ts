import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import { users, verificationTokens } from "@/lib/server/db/schema";
import { getOutboundEmailProviderStatus, sendOutboundEmail, type OutboundEmailDeliveryResult } from "@/lib/server/email/outboundEmail";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import { PASSWORD_RESET_EMAIL_SUBJECT, renderPasswordResetEmailText } from "./passwordResetEmailHandoff";
import { hashPassword, normalizeEmail, validatePassword } from "./password";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_PREFIX = "password-reset:";
const RESET_TTL_MINUTES = 30;

export interface PasswordResetRequestReceipt {
  accepted: true;
  persisted: boolean;
  expiresInMinutes: number;
  resetUrl: string | null;
  emailDelivery: OutboundEmailDeliveryResult;
}

export interface PasswordResetCompleteResult {
  email: string;
}

export class PasswordResetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PasswordResetError";
  }
}

export async function requestPasswordReset(input: {
  email: unknown;
  origin: string;
  callbackUrl?: string | null;
}): Promise<PasswordResetRequestReceipt> {
  const email = normalizeResetEmail(input.email);
  if (!email) {
    throw new PasswordResetError("invalid_email", "올바른 이메일을 입력해주세요.");
  }

  try {
    const db = getCunoteDb();
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) return genericReceipt(false, null, skippedEmailDelivery());

    const rawToken = randomBytes(32).toString("base64url");
    const token = hashResetToken(rawToken);
    const identifier = resetIdentifier(email);
    const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

    await db
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, identifier));
    await db.insert(verificationTokens).values({ identifier, token, expires });

    const resetUrl = buildResetUrl(input.origin, rawToken, input.callbackUrl);
    const emailDelivery = await deliverPasswordResetEmail({
      email,
      resetUrl,
      expiresInMinutes: RESET_TTL_MINUTES,
    });

    return genericReceipt(true, shouldExposePasswordResetUrl() ? resetUrl : null, emailDelivery);
  } catch {
    return genericReceipt(false, null, skippedEmailDelivery());
  }
}

export async function completePasswordReset(input: {
  token: unknown;
  password: unknown;
}): Promise<PasswordResetCompleteResult> {
  if (typeof input.token !== "string" || !input.token.trim()) {
    throw new PasswordResetError("invalid_token", "재설정 링크가 올바르지 않거나 만료되었습니다.");
  }

  const password = validatePassword(input.password);
  if (!password.ok || !password.password) {
    throw new PasswordResetError("invalid_password", password.error ?? "비밀번호를 확인해주세요.");
  }

  const db = getCunoteDb();
  const token = hashResetToken(input.token.trim());
  const [record] = await db
    .select({
      identifier: verificationTokens.identifier,
      token: verificationTokens.token,
      expires: verificationTokens.expires,
    })
    .from(verificationTokens)
    .where(eq(verificationTokens.token, token))
    .limit(1);

  if (!record || !record.identifier.startsWith(RESET_PREFIX) || record.expires.getTime() <= Date.now()) {
    if (record) await deleteResetToken(record.identifier, record.token);
    throw new PasswordResetError("invalid_token", "재설정 링크가 올바르지 않거나 만료되었습니다.");
  }

  const email = record.identifier.slice(RESET_PREFIX.length);
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    await deleteResetToken(record.identifier, record.token);
    throw new PasswordResetError("invalid_token", "재설정 링크가 올바르지 않거나 만료되었습니다.");
  }

  const passwordHash = await hashPassword(password.password);
  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, user.id));
  await db
    .delete(verificationTokens)
    .where(eq(verificationTokens.identifier, record.identifier));

  return { email: user.email };
}

function genericReceipt(
  persisted: boolean,
  resetUrl: string | null,
  emailDelivery: OutboundEmailDeliveryResult,
): PasswordResetRequestReceipt {
  return {
    accepted: true,
    persisted,
    expiresInMinutes: RESET_TTL_MINUTES,
    resetUrl,
    emailDelivery,
  };
}

async function deliverPasswordResetEmail(input: {
  email: string;
  resetUrl: string;
  expiresInMinutes: number;
}): Promise<OutboundEmailDeliveryResult> {
  const legal = getLegalConfig();
  const text = renderPasswordResetEmailText({
    email: input.email,
    resetUrl: input.resetUrl,
    expiresInMinutes: input.expiresInMinutes,
    supportEmail: legal.supportEmail,
  });

  try {
    return await sendOutboundEmail({
      message: {
        to: { email: input.email },
        from: { email: process.env.CUNOTE_EMAIL_FROM?.trim() || legal.supportEmail, name: "창업노트 계정" },
        replyTo: { email: process.env.CUNOTE_EMAIL_REPLY_TO?.trim() || legal.supportEmail },
        subject: PASSWORD_RESET_EMAIL_SUBJECT,
        text,
        tags: ["password_reset"],
      },
    });
  } catch (error) {
    if (error instanceof Error && "result" in error) {
      const result = (error as { result?: OutboundEmailDeliveryResult }).result;
      if (result) return result;
    }
    return { ...getOutboundEmailProviderStatus(), status: "failed" };
  }
}

function skippedEmailDelivery(): OutboundEmailDeliveryResult {
  return { ...getOutboundEmailProviderStatus(), status: "skipped" };
}

function normalizeResetEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = normalizeEmail(value);
  return EMAIL_PATTERN.test(email) ? email : null;
}

function resetIdentifier(email: string): string {
  return `${RESET_PREFIX}${email}`;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function shouldExposePasswordResetUrl(): boolean {
  return process.env.CUNOTE_PASSWORD_RESET_DEBUG_LINK === "true" || process.env.NODE_ENV !== "production";
}

function buildResetUrl(origin: string, token: string, callbackUrl: string | null | undefined): string {
  const url = new URL("/reset-password", origin);
  url.searchParams.set("token", token);
  if (callbackUrl && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")) {
    url.searchParams.set("callbackUrl", callbackUrl);
  }
  return url.toString();
}

async function deleteResetToken(identifier: string, token: string) {
  await getCunoteDb()
    .delete(verificationTokens)
    .where(and(
      eq(verificationTokens.identifier, identifier),
      eq(verificationTokens.token, token),
    ));
}

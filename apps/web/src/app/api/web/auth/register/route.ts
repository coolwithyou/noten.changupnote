import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";
import { hashPassword, validateCredentials } from "@/lib/server/auth/password";

export const dynamic = "force-dynamic";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "잘못된 요청입니다." }, { status: 400 });
  }

  const { email: rawEmail, password: rawPassword, name: rawName } = (body ?? {}) as Record<string, unknown>;
  const validation = validateCredentials(rawEmail, rawPassword);
  if (!validation.ok || !validation.email || !validation.password) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
  }

  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 100) : null;
  const db = getCunoteDb();

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, validation.email))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ ok: false, error: "이미 가입된 이메일입니다." }, { status: 409 });
  }

  const passwordHash = await hashPassword(validation.password);

  try {
    const [created] = await db
      .insert(users)
      .values({ email: validation.email, name, passwordHash })
      .returning({ id: users.id, email: users.email });

    if (!created) {
      return NextResponse.json({ ok: false, error: "가입하지 못했습니다." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, data: { id: created.id, email: created.email } }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ ok: false, error: "이미 가입된 이메일입니다." }, { status: 409 });
    }
    throw error;
  }
}

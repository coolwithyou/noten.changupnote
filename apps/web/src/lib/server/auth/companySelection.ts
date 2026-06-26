import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

export const SELECTED_COMPANY_COOKIE = "cunote_selected_company_id";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function readSelectedCompanyId(): Promise<string | undefined> {
  try {
    const store = await cookies();
    const value = store.get(SELECTED_COMPANY_COOKIE)?.value?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function writeSelectedCompanyId(response: NextResponse, companyId: string) {
  response.cookies.set(SELECTED_COMPANY_COOKIE, companyId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}

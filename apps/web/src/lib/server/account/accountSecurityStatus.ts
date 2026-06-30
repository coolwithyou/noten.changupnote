import { eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";

export type PasswordCredentialStatus = "configured" | "not_configured" | "unknown";
export type LegalAcceptanceStatus = "accepted" | "missing" | "unknown";

export interface AccountSecurityStatus {
  userId: string;
  provider: WebSession["provider"] | "none";
  email: string | null;
  name: string | null;
  passwordCredential: PasswordCredentialStatus;
  legalAcceptance: LegalAcceptanceStatus;
  termsAcceptedAt: string | null;
  privacyAcceptedAt: string | null;
  termsVersion: string | null;
  privacyVersion: string | null;
  currentTermsVersion: string;
  currentPrivacyVersion: string;
}

export async function loadAccountSecurityStatus(input: {
  access: CompanyAccess;
  session: WebSession | null;
}): Promise<AccountSecurityStatus> {
  const legal = getLegalConfig();
  const fallback: AccountSecurityStatus = {
    userId: input.session?.user.id ?? input.access.userId,
    provider: input.session?.provider ?? "none",
    email: input.session?.user.email ?? null,
    name: input.session?.user.name ?? null,
    passwordCredential: "unknown",
    legalAcceptance: "unknown",
    termsAcceptedAt: null,
    privacyAcceptedAt: null,
    termsVersion: null,
    privacyVersion: null,
    currentTermsVersion: legal.termsVersion,
    currentPrivacyVersion: legal.privacyVersion,
  };

  try {
    const [row] = await getCunoteDb()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
        termsAcceptedAt: users.termsAcceptedAt,
        privacyAcceptedAt: users.privacyAcceptedAt,
        termsVersion: users.termsVersion,
        privacyVersion: users.privacyVersion,
      })
      .from(users)
      .where(eq(users.id, fallback.userId))
      .limit(1);

    if (!row) return fallback;

    const termsAcceptedAt = row.termsAcceptedAt?.toISOString() ?? null;
    const privacyAcceptedAt = row.privacyAcceptedAt?.toISOString() ?? null;
    return {
      ...fallback,
      userId: row.id,
      email: row.email ?? fallback.email,
      name: row.name ?? fallback.name,
      passwordCredential: row.passwordHash ? "configured" : "not_configured",
      legalAcceptance: termsAcceptedAt && privacyAcceptedAt ? "accepted" : "missing",
      termsAcceptedAt,
      privacyAcceptedAt,
      termsVersion: row.termsVersion ?? null,
      privacyVersion: row.privacyVersion ?? null,
    };
  } catch {
    return fallback;
  }
}

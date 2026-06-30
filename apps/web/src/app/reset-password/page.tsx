import { redirect } from "next/navigation";
import { PasswordResetPanel } from "@/features/auth/PasswordResetPanel";
import { getOptionalWebSession } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

interface ResetPasswordPageProps {
  searchParams: Promise<{
    callbackUrl?: string | string[];
    token?: string | string[];
  }>;
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const params = await searchParams;
  const callbackUrl = normalizeCallbackUrl(params.callbackUrl);
  const token = normalizeToken(params.token);
  const session = await getOptionalWebSession();
  if (session) redirect(callbackUrl);

  return <PasswordResetPanel mode="confirm" token={token} callbackUrl={callbackUrl} />;
}

function normalizeCallbackUrl(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/dashboard";
  return candidate;
}

function normalizeToken(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.trim() || null;
}

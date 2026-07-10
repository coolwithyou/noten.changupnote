import { redirect } from "next/navigation";
import { PasswordResetPanel } from "@/features/auth/PasswordResetPanel";
import { getOptionalWebSession } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

interface ForgotPasswordPageProps {
  searchParams: Promise<{
    callbackUrl?: string | string[];
  }>;
}

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const params = await searchParams;
  const callbackUrl = normalizeCallbackUrl(params.callbackUrl);
  const session = await getOptionalWebSession();
  if (session) redirect(callbackUrl);

  return <PasswordResetPanel mode="request" callbackUrl={callbackUrl} />;
}

function normalizeCallbackUrl(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/dashboard";
  return candidate;
}

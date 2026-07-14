import { redirect } from "next/navigation";
import { LoginPanel } from "@/features/auth/LoginPanel";
import { getWebAuthProviderSummaries } from "@/lib/server/auth/options";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { safeInternalPath } from "@/lib/navigation/safeInternalPath";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{
    callbackUrl?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const callbackUrl = normalizeCallbackUrl(params.callbackUrl);
  const session = await getOptionalWebSession();
  if (session) redirect(callbackUrl);

  return (
    <LoginPanel
      callbackUrl={callbackUrl}
      providers={getWebAuthProviderSummaries()}
    />
  );
}

function normalizeCallbackUrl(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return safeInternalPath(candidate) ?? "/dashboard";
}

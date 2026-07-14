import { redirect } from "next/navigation";
import { safeInternalPath } from "@/lib/navigation/safeInternalPath";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const rawNext = Array.isArray(query.next) ? query.next[0] : query.next;
  const next = safeInternalPath(rawNext);
  const params = new URLSearchParams({ companyRequired: "1" });
  if (next) params.set("next", next);
  redirect(`/?${params.toString()}`);
}

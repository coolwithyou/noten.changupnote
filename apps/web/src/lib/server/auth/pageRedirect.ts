import { redirect } from "next/navigation";
import { AuthRequiredError } from "./session";

export function redirectOnAuthRequired(error: unknown, callbackUrl: string): never {
  if (error instanceof AuthRequiredError) {
    const params = new URLSearchParams({ callbackUrl });
    redirect(`/login?${params.toString()}`);
  }
  throw error;
}

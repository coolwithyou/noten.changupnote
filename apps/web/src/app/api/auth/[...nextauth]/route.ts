import { appNotImplemented } from "@/lib/server/appApi/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return appNotImplemented("NextAuth route");
}

export async function POST() {
  return appNotImplemented("NextAuth route");
}

import { appNotImplemented } from "@/lib/server/appApi/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return appNotImplemented("앱 로그아웃");
}

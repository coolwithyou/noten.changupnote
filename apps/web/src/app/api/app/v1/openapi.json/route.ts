import { appV1OpenApi } from "@cunote/contracts";
import { NextResponse } from "next/server";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(appV1OpenApi);
}

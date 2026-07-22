import { NextResponse } from "next/server";
import { binaryDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { readRoundtripFillArtifact } from "@/lib/server/analysis-lab/application-roundtrip/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const params = new URL(request.url).searchParams;
  const grantId = params.get("grantId")?.trim() ?? "";
  const runId = params.get("runId")?.trim() ?? "";
  const fillId = params.get("fillId")?.trim() ?? "";
  if (!grantId || !runId || !fillId) {
    return NextResponse.json({ error: "invalid_request", message: "다운로드 식별자가 필요합니다." }, { status: 400 });
  }
  const artifact = await readRoundtripFillArtifact({ grantId, runId, fillId });
  if (!artifact) return NextResponse.json({ error: "not_found", message: "저장본을 찾지 못했습니다." }, { status: 404 });
  return binaryDownloadResponse({
    body: artifact.body,
    filename: artifact.result.outputFilename,
    fallbackFilename: artifact.result.outputFormat === "hwpx" ? "filled-application.hwpx" : "filled-application.hwp",
    contentType: artifact.result.outputFormat === "hwpx" ? "application/vnd.hancom.hwpx" : "application/x-hwp",
  });
}

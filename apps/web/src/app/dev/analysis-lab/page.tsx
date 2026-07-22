import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnalysisLabWorkspace } from "@/features/dev/analysis-lab/AnalysisLabWorkspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "공모 분석 실험실 (dev)",
  robots: { index: false, follow: false },
};

export default function DevAnalysisLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AnalysisLabWorkspace />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ServiceDataMonitor } from "@/features/dev/ServiceDataMonitor";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "사업자 데이터 모니터 (dev)",
  robots: { index: false, follow: false },
};

export default function DevServiceDataPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ServiceDataMonitor />;
}

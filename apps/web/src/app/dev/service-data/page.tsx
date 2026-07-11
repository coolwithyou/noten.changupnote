import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ServiceDataMonitor } from "@/features/dev/ServiceDataMonitor";
import { buildQnaSchema } from "@/lib/server/devServiceDataMonitor";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "사업자 데이터 모니터 (dev)",
  robots: { index: false, follow: false },
};

export default function DevServiceDataPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // canonical 파생 Q&A 스키마는 서버에서 만들어 클라이언트에 넘긴다
  // (클라이언트 번들에 @cunote/core 를 끌어들이지 않기 위함).
  return <ServiceDataMonitor qnaSchema={buildQnaSchema()} />;
}

import { redirect } from "next/navigation";
import { OpsDashboardShell } from "@/components/OpsDashboardShell";
import { SourceCorrectionQueue } from "@/components/SourceCorrectionQueue";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { loadAdminSourceCorrections } from "@/lib/server/admin/sourceCorrections";
export const dynamic = "force-dynamic";
export default async function SourceCorrectionsPage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  if (!["support", "admin", "owner"].includes(session.user.role)) redirect("/");
  const enabled = process.env.CUNOTE_SOURCE_CORRECTIONS_ENABLED === "true";
  const records = enabled ? await loadAdminSourceCorrections(session) : [];
  return <OpsDashboardShell title="원천 정보 정정" user={{ email: session.user.email, name: session.user.name ?? null, role: session.user.role }}>
    <main className="flex flex-col gap-4 p-4 md:p-6">{enabled ? <SourceCorrectionQueue initialRecords={records} /> : <p>마이그레이션과 원천 정정 설정 확인 후 활성화할 수 있습니다.</p>}</main>
  </OpsDashboardShell>;
}

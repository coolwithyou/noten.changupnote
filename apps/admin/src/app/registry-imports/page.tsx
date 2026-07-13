import { redirect } from "next/navigation";
import { OpsDashboardShell } from "@/components/OpsDashboardShell";
import { listRegistryImportRuns, registrySourceOptions } from "@/lib/server/admin/registryImports";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import RegistryImportPanel from "./RegistryImportPanel";

export const dynamic = "force-dynamic";

export default async function RegistryImportsPage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  if (session.user.role !== "owner" && session.user.role !== "admin") redirect("/");
  const runs = await listRegistryImportRuns();

  return (
    <OpsDashboardShell
      title="공개명단 업데이트"
      user={{ email: session.user.email, name: session.user.name ?? null, role: session.user.role }}
    >
      <main className="flex flex-col gap-6 p-4 md:p-6">
        <header className="flex flex-col gap-1">
          <h2 className="font-heading text-2xl font-semibold tracking-tight">공개명단 CSV 업데이트</h2>
          <p className="text-sm text-muted-foreground">
            새 파일을 검증하고 현재 활성 버전과 비교한 뒤 안전하게 전환합니다. 실패한 파일은 서비스 데이터에 영향을 주지 않습니다.
          </p>
        </header>
        <RegistryImportPanel initialRuns={runs} sources={registrySourceOptions()} />
      </main>
    </OpsDashboardShell>
  );
}

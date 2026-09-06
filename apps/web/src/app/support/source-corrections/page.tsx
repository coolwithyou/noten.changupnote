import Link from "next/link";
import { redirect } from "next/navigation";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { requestCompanyScope } from "@/lib/server/auth/requestCompanyScope";
import { resolveProductCompanyProfileWithoutCorrections } from "@/lib/server/serviceData";
import { listSourceCorrections, sourceCorrectionsEnabled } from "@/lib/server/productProfile/sourceCorrections";
import { SourceCorrectionForm } from "@/features/support/SourceCorrectionForm";
export const dynamic = "force-dynamic";
export default async function SourceCorrectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const path = `/support/source-corrections${typeof params.companyId === "string" ? `?companyId=${encodeURIComponent(params.companyId)}` : ""}`;
  if (!await getOptionalWebSession()) redirect(`/login?callbackUrl=${encodeURIComponent(path)}`);
  if (!sourceCorrectionsEnabled()) return <main className="mx-auto max-w-2xl p-6"><h1>원천 정보 정정</h1><p>원천 정정 기능을 준비 중입니다. 현재는 고객지원에 문의해주세요.</p><Link href="/support">고객지원</Link></main>;
  const access = await requireCompanyAccess(requestCompanyScope(params.companyId));
  const [resolution, records] = await Promise.all([
    resolveProductCompanyProfileWithoutCorrections({ context: "owned_read", companyId: access.companyId, userId: access.userId, asOf: new Date().toISOString() }),
    listSourceCorrections(access),
  ]);
  return <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6"><h1>{resolution.profile.name ?? "선택한 회사"} · 원천 정보 정정</h1>
    <Link href={`/matches?companyId=${encodeURIComponent(access.companyId)}`}>이 회사 매칭으로 돌아가기</Link>
    <SourceCorrectionForm companyId={access.companyId} rows={resolution.view.rows} initialRecords={records} canWrite={access.role !== "viewer"} />
  </main>;
}

import { notFound } from "next/navigation";
import Link from "next/link";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { listReviewDocs, type ReviewStatus } from "@/lib/server/review/reviewDocsRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "대기",
  in_review: "검수중",
  approved: "확정",
};

const STATUS_BADGE: Record<ReviewStatus, string> = {
  pending: "bg-slate-100 text-slate-700",
  in_review: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
};

export default async function ReviewListPage() {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  const docs = await listReviewDocs();
  const approved = docs.filter((d) => d.reviewStatus === "approved").length;
  const inReview = docs.filter((d) => d.reviewStatus === "in_review").length;
  const pending = docs.filter((d) => d.reviewStatus === "pending").length;
  const total = docs.length;
  const pct = total > 0 ? Math.round((approved / total) * 100) : 0;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-900">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gate 1 · 필드맵 검수</p>
        <h1 className="mt-1 text-2xl font-bold">리뷰어 워크스페이스</h1>
        <p className="mt-2 text-sm text-slate-600">
          검수 확정이 곧 golden 승격입니다. 누락 필드 &gt; 오분류 &gt; bbox 순으로 확인하세요.
          <span className="ml-2 text-slate-400">검수자: {reviewer.email}</span>
        </p>
      </header>

      <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="확정" value={`${approved}/${total}`} />
        <Stat label="검수중" value={String(inReview)} />
        <Stat label="대기" value={String(pending)} />
        <Stat label="진행률" value={`${pct}%`} />
      </section>

      <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-semibold">문서</th>
              <th className="px-4 py-3 font-semibold">파일명</th>
              <th className="px-4 py-3 text-right font-semibold">필드</th>
              <th className="px-4 py-3 font-semibold">상태</th>
              <th className="px-4 py-3 font-semibold">검수자</th>
              <th className="px-4 py-3 font-semibold">교정</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link href={`/internal/review/${doc.docId}`} className="font-semibold text-indigo-600 hover:underline">
                    {doc.docId}
                  </Link>
                </td>
                <td className="max-w-xs truncate px-4 py-3 text-slate-600" title={doc.sourceFilename ?? ""}>
                  {doc.sourceFilename ?? "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{doc.fieldCount}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[doc.reviewStatus]}`}>
                    {STATUS_LABEL[doc.reviewStatus]}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">{doc.reviewedBy ?? "—"}</td>
                <td className="px-4 py-3">
                  {doc.hasCorrectionNotes ? (
                    <span className="inline-block rounded bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">교정</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
            {docs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                  임포트된 검수 문서가 없습니다. <code>pnpm import:review-docs -- --write</code> 를 실행하세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

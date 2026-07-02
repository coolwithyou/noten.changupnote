import { notFound } from "next/navigation";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { getReviewDocByDocId } from "@/lib/server/review/reviewDocsRepo";
import { ReviewDetailView } from "@/features/review/ReviewDetailView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ docId: string }>;
}

export default async function ReviewDetailPage({ params }: PageProps) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  const { docId } = await params;
  const doc = await getReviewDocByDocId(docId);
  if (!doc) notFound();

  return (
    <ReviewDetailView
      reviewerEmail={reviewer.email}
      doc={{
        docId: doc.docId,
        docRef: doc.docRef,
        sourceFilename: doc.sourceFilename,
        pageCount: doc.pageCount,
        reviewStatus: doc.reviewStatus,
        reviewedBy: doc.reviewedBy,
        correctionNotes: doc.correctionNotes,
        labeledBy: doc.labeledBy,
        labelJson: doc.labelJson,
        pageImageKeys: doc.pageImageKeys,
      }}
    />
  );
}

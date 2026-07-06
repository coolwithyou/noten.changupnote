import { notFound } from "next/navigation";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { getReviewDocByDocId } from "@/lib/server/review/reviewDocsRepo";
import { listQuestionsForDoc } from "@/lib/server/review/reviewQuestionsRepo";
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

  const questions = await listQuestionsForDoc(doc.id);

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
        reviewerComment: doc.reviewerComment,
        labeledBy: doc.labeledBy,
        labelJson: doc.labelJson,
        pageImageKeys: doc.pageImageKeys,
        evidence: doc.evidence,
      }}
      questions={questions.map((q) => ({
        id: q.id,
        fieldIndex: q.fieldIndex,
        page: q.page,
        kind: q.kind,
        prompt: q.prompt,
        answerType: q.answerType,
        options: q.options,
        orderIndex: q.orderIndex,
        answer: q.answer,
      }))}
    />
  );
}

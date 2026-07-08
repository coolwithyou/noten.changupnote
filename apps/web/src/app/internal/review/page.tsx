import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, BookOpen } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { listReviewDocs, type ReviewStatus } from "@/lib/server/review/reviewDocsRepo";
import { ReviewWorkspaceShell } from "@/features/review/ReviewWorkspaceShell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "대기",
  in_review: "검수중",
  approved: "확정",
};

function statusVariant(status: ReviewStatus): "default" | "secondary" | "outline" {
  if (status === "approved") return "default";
  if (status === "in_review") return "secondary";
  return "outline";
}

function formatApplyDate(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  })
    .format(value)
    .replace(/\s/g, "")
    .replace(/\.$/, "");
}

/** 공고 접수 기간 부기 라벨. 둘 다 없으면 null(미표기). */
function applyPeriodLabel(start: Date | null, end: Date | null): string | null {
  if (!start && !end) return null;
  if (!start) return `마감 ${formatApplyDate(end!)}`;
  if (!end) return `${formatApplyDate(start)} 시작`;
  return `${formatApplyDate(start)} ~ ${formatApplyDate(end)}`;
}

export default async function ReviewListPage() {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  const docs = await listReviewDocs();
  const approved = docs.filter((d) => d.reviewStatus === "approved").length;
  const inReview = docs.filter((d) => d.reviewStatus === "in_review").length;
  const pending = docs.filter((d) => d.reviewStatus === "pending").length;
  const total = docs.length;
  const pct = total > 0 ? Math.round((approved / total) * 100) : 0;

  const nextDoc =
    docs.find((d) => d.reviewStatus === "pending") ??
    docs.find((d) => d.reviewStatus === "in_review") ??
    null;

  const actions = (
    <>
      <Link
        href="/internal/review/guide"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        <BookOpen data-icon="inline-start" />
        검수 가이드
      </Link>
      {nextDoc ? (
        <Link href={`/internal/review/${nextDoc.docId}`} className={cn(buttonVariants({ size: "sm" }))}>
          다음 미검수
          <ArrowRight data-icon="inline-end" />
        </Link>
      ) : null}
    </>
  );

  return (
    <ReviewWorkspaceShell
      reviewerEmail={reviewer.email}
      currentPath="/internal/review"
      title="리뷰어 워크스페이스"
      description="검수 확정이 곧 golden 승격입니다. 누락 필드, 오분류, bbox 순서로 확인하세요."
      badge="Gate 1 · 필드맵 검수"
      actions={actions}
      metrics={[
        { label: "확정", value: `${approved}/${total}` },
        { label: "검수중", value: inReview },
        { label: "대기", value: pending },
        { label: "진행률", value: `${pct}%` },
      ]}
    >
      <div className="flex w-full max-w-screen-2xl flex-col gap-4">
        <Alert>
          <AlertTitle>처음이라면 검수 가이드부터 확인하세요.</AlertTitle>
          <AlertDescription>
            우선순위는 누락 필드, 오분류, 상자 위치입니다. 애매한 항목은 확정하지 말고 필드 보류로 남깁니다.
          </AlertDescription>
        </Alert>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="확정" value={`${approved}/${total}`} description="golden 승격 완료" />
          <StatCard label="검수중" value={String(inReview)} description="초안 저장됨" />
          <StatCard label="대기" value={String(pending)} description="아직 미검수" />
          <StatCard label="진행률" value={`${pct}%`} description="전체 문서 기준" />
        </section>

        <Card>
          <CardHeader>
            <CardTitle>전체 진행</CardTitle>
            <CardDescription>확정된 문서 비율입니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={pct} className="w-full">
              <ProgressLabel>승격 진행률</ProgressLabel>
              <ProgressValue />
            </Progress>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>문서 목록</CardTitle>
            <CardDescription>문서를 열어 질문 모드 또는 전문 모드로 검수합니다.</CardDescription>
            <CardAction>
              <Badge variant="secondary">{total}건</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            {docs.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>문서</TableHead>
                    <TableHead>파일명</TableHead>
                    <TableHead className="text-right">필드</TableHead>
                    <TableHead>상태</TableHead>
                    <TableHead>검수자</TableHead>
                    <TableHead>교정</TableHead>
                    <TableHead>보류·메모</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map((doc) => (
                    <TableRow key={doc.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/internal/review/${doc.docId}`}
                          className="block max-w-[360px] truncate text-primary hover:underline"
                          title={doc.grantTitle ?? doc.docId}
                        >
                          {doc.grantTitle ?? doc.docId}
                        </Link>
                        {doc.grantTitle ? (
                          <span className="text-xs text-muted-foreground">
                            {doc.docId}
                            {applyPeriodLabel(doc.grantApplyStart, doc.grantApplyEnd) ? (
                              <> · {applyPeriodLabel(doc.grantApplyStart, doc.grantApplyEnd)}</>
                            ) : null}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate text-muted-foreground" title={doc.sourceFilename ?? ""}>
                        {doc.sourceFilename ?? "-"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{doc.fieldCount}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(doc.reviewStatus)}>{STATUS_LABEL[doc.reviewStatus]}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{doc.reviewedBy ?? "-"}</TableCell>
                      <TableCell>
                        {doc.hasCorrectionNotes ? <Badge variant="destructive">교정</Badge> : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {doc.heldCount > 0 ? <Badge variant="secondary">보류 {doc.heldCount}</Badge> : null}
                          {doc.hasReviewerComment ? <Badge variant="outline">코멘트</Badge> : null}
                          {doc.heldCount === 0 && !doc.hasReviewerComment ? (
                            <span className="text-muted-foreground">-</span>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty className="border border-border">
                <EmptyHeader>
                  <EmptyTitle>임포트된 검수 문서가 없습니다.</EmptyTitle>
                  <EmptyDescription>
                    <code>pnpm import:review-docs -- --write</code> 실행 후 다시 확인하세요.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent />
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </ReviewWorkspaceShell>
  );
}

function StatCard({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

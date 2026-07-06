import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { KnowledgeDashboardTotals } from "@/lib/server/knowledge/knowledgeDashboardData";
import {
  LESSON_STATUS_LABEL,
  LESSON_STATUS_ORDER,
  SOURCE_KIND_LABEL,
  SOURCE_KIND_ORDER,
  type KnowledgeSourceKind,
  type LessonStatus,
} from "./knowledgeLabels";

interface KnowledgeMetricCardsProps {
  totals: KnowledgeDashboardTotals;
  reviewDueCount: number;
}

/** (b) 지표 카드 행 — 누적/승인/원천/검수대기/재검토임박 5장. */
export function KnowledgeMetricCards({ totals, reviewDueCount }: KnowledgeMetricCardsProps) {
  const lessons = totals.lessons;
  const totalLessons = LESSON_STATUS_ORDER.reduce((sum, s) => sum + (lessons[s] ?? 0), 0);
  const approved = lessons.approved ?? 0;
  const proposed = lessons.proposed ?? 0;
  const approvedPct = totalLessons > 0 ? Math.round((approved / totalLessons) * 100) : 0;

  const lessonBreakdown = LESSON_STATUS_ORDER.map(
    (s: LessonStatus) => `${LESSON_STATUS_LABEL[s]} ${lessons[s] ?? 0}`,
  ).join(" · ");

  const kindBreakdown =
    SOURCE_KIND_ORDER.filter((k: KnowledgeSourceKind) => (totals.sources.byKind[k] ?? 0) > 0)
      .map((k) => `${SOURCE_KIND_LABEL[k]} ${totals.sources.byKind[k]}`)
      .join(" · ") || "종류 미분류";

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <MetricCard label="누적 lesson" value={totalLessons.toLocaleString("ko-KR")} note={lessonBreakdown} />
      <MetricCard
        label="승인된 지식"
        value={approved.toLocaleString("ko-KR")}
        note={`전체 lesson의 ${approvedPct}%`}
        accent
      />
      <MetricCard label="원천 문서" value={totals.sources.total.toLocaleString("ko-KR")} note={kindBreakdown} />
      <MetricCard
        label="검수 대기"
        value={proposed.toLocaleString("ko-KR")}
        note="인박스에서 검수 →"
        href="/internal/review/lessons"
      />
      <MetricCard
        label="재검토 임박"
        value={reviewDueCount > 0 ? reviewDueCount.toLocaleString("ko-KR") : "없음"}
        note={reviewDueCount > 0 ? "90일 내 재검토 예정" : "임박 항목 없음"}
      />
    </section>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  note: ReactNode;
  href?: string;
  accent?: boolean;
}

function MetricCard({ label, value, note, href, accent }: MetricCardProps) {
  const card = (
    <Card
      size="sm"
      className={cn(
        "h-full",
        href && "transition-colors hover:bg-muted/40 hover:ring-foreground/20",
      )}
    >
      <CardHeader>
        <CardDescription className="flex items-center justify-between gap-1">
          {label}
          {href ? <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden /> : null}
        </CardDescription>
        <CardTitle
          className={cn("text-2xl tabular-nums", accent && "text-primary")}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="truncate text-xs text-muted-foreground" title={typeof note === "string" ? note : undefined}>
          {note}
        </p>
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <Link href={href} className="block focus-visible:outline-none">
        {card}
      </Link>
    );
  }
  return card;
}

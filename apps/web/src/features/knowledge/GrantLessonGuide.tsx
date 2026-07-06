"use client";

/**
 * 지식 루프 Step 3 — 지원 준비 화면의 "작성 유의사항" 패널.
 *
 * matchApprovedLessonsForGrant(server)가 조립한 GrantLessonGuideDto 를 받아,
 * 운영팀이 검수·확정한 승인 lesson 을 공고 상세 화면에 노출한다. 지식이 처음으로
 * 제품에 흐르는 소비처다(계획 docs/plans/2026-07-05-ops-knowledge-ingestion.md §3).
 *
 * LessonInboxView 선례를 따라 서버(drizzle) 모듈을 클라이언트로 끌어오지 않는다:
 * DTO 는 `import type` 으로만 참조하고, 라벨·톤 맵은 로컬 상수로 둔다(런타임 의존 0).
 */
import { useState } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { GrantLessonGuideDto } from "@/lib/server/knowledge/lessonContext";

// ── 로컬 라벨·톤(knowledgeRepo 리터럴과 동일, 클라이언트 안전) ──────
const TARGET_LABEL: Record<string, string> = {
  classification: "분류",
  criteria: "자격·전제조건",
  fill_value: "기입값·한도",
  field_interpretation: "필드 해석",
  guide: "작성 지침",
  evaluation: "심사 관점",
};
function labelForTarget(target: string): string {
  return TARGET_LABEL[target] ?? target;
}

type TierTone = "amber" | "emerald" | "neutral";
const TIER_META: Record<string, { label: string; tone: TierTone }> = {
  staff_confirmed: { label: "담당자 확인", tone: "amber" },
  official_document: { label: "공식 문서", tone: "emerald" },
  ops_inference: { label: "운영 추정", tone: "neutral" },
};
const TIER_TONE_CLASS: Record<TierTone, string> = {
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  neutral: "border-border bg-muted/50 text-muted-foreground",
};
function tierMeta(tier: string): { label: string; tone: TierTone } {
  return TIER_META[tier] ?? { label: tier, tone: "neutral" };
}

// 접힘 임계치: 유의사항이 이보다 많으면 기본 접힘 + "전체 보기" 토글.
const COLLAPSE_CAP = 6;

export function GrantLessonGuide({ guide }: { guide: GrantLessonGuideDto }) {
  const [expanded, setExpanded] = useState(false);

  if (!guide.matched || guide.total === 0) return null;

  const collapsible = guide.total > COLLAPSE_CAP;
  const showAll = !collapsible || expanded;

  // group 순서를 보존하며 접힘 상태에서는 앞선(중요) 그룹부터 COLLAPSE_CAP 건까지만 노출.
  let remaining = showAll ? Number.POSITIVE_INFINITY : COLLAPSE_CAP;
  const rendered = guide.groups
    .map((group) => {
      const lessons = showAll ? group.lessons : group.lessons.slice(0, Math.max(0, remaining));
      remaining -= lessons.length;
      return { target: group.target, lessons };
    })
    .filter((group) => group.lessons.length > 0);

  return (
    <Card id="lesson-guide" aria-label="작성 유의사항">
      <CardHeader className="gap-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          운영 검증 지식
        </span>
        <CardTitle className="text-lg">작성 유의사항</CardTitle>
        <CardDescription>
          운영팀이 담당자 확인·검증한 지식 {guide.total.toLocaleString("ko-KR")}건
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {rendered.map((group) => (
          <section key={group.target} className="grid gap-2.5">
            <h3 className="text-sm font-semibold text-foreground">{labelForTarget(group.target)}</h3>
            <ul className="grid gap-2">
              {group.lessons.map((lesson) => {
                const tier = tierMeta(lesson.evidenceTier);
                return (
                  <li
                    key={lesson.id}
                    className="grid gap-2 rounded-[var(--radius-lg)] border bg-card p-3"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className={cn("gap-1", TIER_TONE_CLASS[tier.tone])}>
                        {tier.tone === "amber" ? (
                          <CircleAlert className="size-3" aria-hidden />
                        ) : null}
                        {tier.label}
                      </Badge>
                      {lesson.programRound ? (
                        <Badge variant="ghost">{lesson.programRound}</Badge>
                      ) : null}
                      {lesson.needsReview ? (
                        <Badge
                          variant="outline"
                          className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        >
                          <CircleAlert className="size-3" aria-hidden />
                          재검토 필요
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm leading-6 text-foreground">{lesson.instruction}</p>
                    {lesson.rationale ? (
                      <p className="text-xs leading-5 text-muted-foreground">{lesson.rationale}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="justify-self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {expanded
              ? "접기"
              : `유의사항 ${guide.total.toLocaleString("ko-KR")}건 전체 보기`}
          </button>
        ) : null}

        <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">
          이 지식은 운영팀 검수를 거쳐 제공됩니다. 공고 원문과 충돌하면 공고 원문이 우선합니다.
        </p>
      </CardContent>
    </Card>
  );
}

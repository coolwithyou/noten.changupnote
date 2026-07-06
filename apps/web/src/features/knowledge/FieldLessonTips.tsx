"use client";

/**
 * 지식 루프 Step 3 — 지원서 작성 항목 옆 인라인 '작성 팁'.
 *
 * matchFieldLessonTips(server)가 라벨별로 조립한 FieldLessonTip[] 를 받아,
 * "입력 필요" 질문 항목·서식 필드 라벨 바로 옆에 승인 lesson 을 소형 팁으로 노출한다.
 * (fieldPattern 필드 레벨 매칭의 첫 소비처 — 공고 레벨 GrantLessonGuide 의 필드 판)
 *
 * GrantLessonGuide 선례를 따라 서버(drizzle) 모듈을 클라이언트로 끌어오지 않는다:
 * 타입은 `import type` 으로만 참조하고, evidenceTier 톤 맵은 로컬 상수로 둔다.
 */
import { useState } from "react";
import { CircleAlert, Lightbulb } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FieldLessonTip } from "@/lib/server/knowledge/lessonContext";

// ── evidenceTier 톤(GrantLessonGuide 와 동일: 담당자 확인=amber·공식 문서=emerald·운영 추정=gray) ──
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

export function FieldLessonTips({ tips }: { tips: FieldLessonTip[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tips.length === 0) return null;

  const first = tips[0]!;
  const extraCount = tips.length - 1;
  const hasMore = extraCount > 0;
  // 토글 조건: 팁이 2건 이상(더 보기)이거나, 1건이라도 근거가 있으면(근거 보기).
  const canToggle = hasMore || Boolean(first.rationale?.trim());
  const visible = expanded ? tips : [first];

  return (
    <div className="mt-2 grid gap-1.5 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
      <span className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Lightbulb className="size-3.5" aria-hidden />
        작성 팁
      </span>
      <ul className="grid gap-2">
        {visible.map((tip) => {
          const tier = tierMeta(tip.evidenceTier);
          return (
            <li key={tip.id} className="grid gap-1">
              <div className="flex flex-wrap items-center gap-1">
                <Badge variant="outline" className={cn("gap-1", TIER_TONE_CLASS[tier.tone])}>
                  {tier.tone === "amber" ? <CircleAlert className="size-3" aria-hidden /> : null}
                  {tier.label}
                </Badge>
                {tip.needsReview ? (
                  <Badge
                    variant="outline"
                    className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  >
                    <CircleAlert className="size-3" aria-hidden />
                    재검토 필요
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs leading-5 text-foreground">{tip.instruction}</p>
              {expanded && tip.rationale?.trim() ? (
                <p className="text-[0.6875rem] leading-5 text-muted-foreground">{tip.rationale}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="justify-self-start text-xs font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-400"
        >
          {expanded ? "접기" : hasMore ? `팁 ${extraCount.toLocaleString("ko-KR")}개 더 보기` : "근거 보기"}
        </button>
      ) : null}
    </div>
  );
}

"use client";

import { CalendarClock, PartyPopper, Save, Sparkles, Wallet } from "lucide-react";
import type { TeaserResult } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { bestFitScore, formatKrwAmount, readyHeadlineCount, searchContextNote } from "./logic";

export function ResultsHero({
  teaser,
  maskedBiz,
  onSave,
  saving,
}: {
  teaser: TeaserResult;
  maskedBiz: string | null;
  onSave: () => void;
  saving: boolean;
}) {
  const headline = readyHeadlineCount(teaser);
  const best = bestFitScore(teaser);
  const contextNote = searchContextNote(teaser.searchContext);
  const amountLabel = teaser.estimatedMaxAmount > 0 ? formatKrwAmount(teaser.estimatedMaxAmount) : "확인 중";

  return (
    <section
      data-zone="brand"
      className="texture-grain relative isolate overflow-hidden rounded-[var(--radius-xl)] bg-brand-band shadow-[var(--shadow-elevated)]"
    >
      <span className="glow-brand pointer-events-none absolute -right-24 -top-24 size-72 opacity-70" aria-hidden />
      <div className="relative flex flex-col gap-7 px-6 py-8 sm:px-8 sm:py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <Badge variant="secondary">
            <Sparkles data-icon="inline-start" />
            {maskedBiz ? `${maskedBiz} 조회 완료` : "조회 완료"}
          </Badge>
          <Button type="button" variant="secondary" onClick={onSave} disabled={saving}>
            <Save data-icon="inline-start" />
            {saving ? "저장 중…" : "결과 저장하기"}
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          {headline.tone === "recommendable" ? (
            <span className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary-foreground/80">
              <PartyPopper className="size-4" aria-hidden />
              축하해요, 지원 가능한 사업을 찾았어요
            </span>
          ) : null}
          <h1 className="max-w-3xl font-heading text-2xl font-bold leading-tight tracking-tight text-primary-foreground sm:text-3xl">
            {headline.tone === "recommendable" ? (
              <>
                지원 가능한 사업 <span className="text-brand-mint">{headline.count.toLocaleString("ko-KR")}건</span>을 찾았어요
              </>
            ) : headline.tone === "review" ? (
              <>
                조건을 확인하면 열리는 사업 <span className="text-brand-mint">{headline.count.toLocaleString("ko-KR")}건</span>을 찾았어요
              </>
            ) : (
              <>아직 조건에 맞는 사업을 찾지 못했어요</>
            )}
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-primary-foreground/75">
            내 사업자 정보를 표준 조건과 대조한 결과예요. 아래에서 조건별 충족 여부를 함께 확인할 수 있어요.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile icon={<Wallet className="size-4" aria-hidden />} label="총 지원 가능액" value={amountLabel} />
          <StatTile
            icon={<CalendarClock className="size-4" aria-hidden />}
            label="마감 임박"
            value={`${teaser.counts.deadlineSoon.toLocaleString("ko-KR")}건`}
          />
          <StatTile
            icon={<Sparkles className="size-4" aria-hidden />}
            label="최고 적합도"
            value={best === null ? "확인 필요" : `${best}%`}
          />
        </div>

        {contextNote ? <p className="text-xs leading-5 text-primary-foreground/60">{contextNote}</p> : null}
      </div>
    </section>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card size="sm" className="ring-0">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="font-heading text-xl font-bold leading-none text-foreground tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

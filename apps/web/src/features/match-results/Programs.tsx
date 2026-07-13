"use client";

import { useState } from "react";
import { ArrowRight, Check, ChevronDown, FilePen, HelpCircle, Minus, ShieldQuestion } from "lucide-react";
import type { MatchCard, RuleTraceChip, RuleTraceChipResult, TeaserResult } from "@cunote/contracts";
import { cn } from "@/lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { MatchFeedbackControls } from "@/features/opportunity-map/MatchFeedbackControls";
import {
  clampPct,
  criterionKindLabel,
  criterionResultText,
  eligibilityLabel,
  formatAmount,
  formatDday,
  isReviewNeededMatch,
  isRecommendableMatch,
  isUrgentDday,
  isWriteSupported,
  writeSupportCta,
  writeSupportLabel,
  writeSupportNote,
} from "./logic";

export function ProgramsExperience({
  teaser,
  onPrepare,
  preparing,
}: {
  teaser: TeaserResult;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
}) {
  const recommendableMatches = teaser.recommendableMatches ?? teaser.matches.filter(isRecommendableMatch);
  const reviewNeededMatches = teaser.reviewNeededMatches ?? teaser.matches.filter(isReviewNeededMatch);

  return (
    <>
      <ProgramsSection
        heading="지원 가능한 사업"
        emptyText="현재 정보로 바로 지원 가능하다고 확인된 사업은 아직 없어요."
        matches={recommendableMatches}
        onPrepare={onPrepare}
        preparing={preparing}
      />
      <ProgramsSection
        heading="확인이 필요한 사업"
        description="업종, 인증, 수행실적처럼 원문 확인이 필요한 조건이 있어요."
        emptyText="원문 확인이 필요한 후보 사업은 없어요."
        matches={reviewNeededMatches}
        onPrepare={onPrepare}
        preparing={preparing}
        tone="review"
      />
    </>
  );
}

function ProgramsSection({
  heading,
  description,
  emptyText,
  matches,
  onPrepare,
  preparing,
  tone = "default",
}: {
  heading: string;
  description?: string;
  emptyText: string;
  matches: MatchCard[];
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  tone?: "default" | "review";
}) {
  if (matches.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-lg font-semibold tracking-tight">{heading}</h2>
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Minus />
            </EmptyMedia>
            <EmptyDescription>{emptyText}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }

  const writeSupportedCount = matches.filter((match) => isWriteSupported(match.writeSupport)).length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-lg font-semibold tracking-tight">{heading}</h2>
            <Badge variant={tone === "review" ? "secondary" : "default"}>{matches.length}건</Badge>
          </div>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : writeSupportedCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              표시된 {matches.length}건 중 <span className="font-semibold text-primary">{writeSupportedCount}건</span>은
              지원서·사업계획서 작성을 도와드릴 수 있어요.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {matches.map((match, index) => (
          <ProgramCard
            key={match.grantId}
            match={match}
            defaultOpen={index === 0}
            onPrepare={onPrepare}
            preparing={preparing}
          />
        ))}
      </div>
    </section>
  );
}

function ProgramCard({
  match,
  defaultOpen,
  onPrepare,
  preparing,
}: {
  match: MatchCard;
  defaultOpen: boolean;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const criteria = match.ruleTrace;
  const passCount = criteria.filter((chip) => chip.result === "pass").length;
  const reviewCount = criteria.filter((chip) => chip.result === "unknown" || chip.result === "text_only").length;
  const scoreHidden = match.criteriaExtracted === false || match.scoreDisplay === "hidden";
  const primaryReviewReason = match.reviewReasons?.[0];
  const disqualificationReason = match.reviewReasons?.some(
    (reason) => reason.code === "disqualification_unconfirmed",
  );
  const writeLabel = writeSupportLabel(match.writeSupport);
  const relevanceLabel = match.ranking?.relevanceScore == null || match.ranking.relevanceScore < 40
    ? null
    : match.ranking.relevanceScore >= 70
      ? "관련성 높음"
      : "관련성 보통";
  const urgent = isUrgentDday(match.dDay);

  return (
    <Card className="overflow-hidden p-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-4 px-5 py-5 text-left">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-[220px] flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={
                    match.eligibility === "eligible"
                      ? "default"
                      : match.eligibility === "conditional"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {eligibilityLabel(match.eligibility)}
                </Badge>
                <Badge variant={urgent ? "destructive" : "outline"}>{formatDday(match.dDay)}</Badge>
                {writeLabel ? (
                  <Badge variant="secondary">
                    {isWriteSupported(match.writeSupport) ? <FilePen data-icon="inline-start" /> : null}
                    {writeLabel}
                  </Badge>
                ) : null}
                {relevanceLabel ? <Badge variant="outline">{relevanceLabel}</Badge> : null}
              </div>
              <div className="font-heading text-base font-semibold leading-snug">{match.title}</div>
              <div className="text-sm text-muted-foreground">
                {match.agency ?? "운영기관 확인"} · <span className="font-medium text-foreground">{formatAmount(match.supportAmount)}</span>
              </div>
            </div>
            <div className="flex min-w-[136px] flex-none flex-col items-end gap-2">
              <div className="text-xs text-muted-foreground">조건 확인도</div>
              {scoreHidden ? (
                <>
                  <div className="font-heading text-base font-semibold leading-none text-muted-foreground">확인 필요</div>
                  {primaryReviewReason ? (
                    <div className="max-w-[180px] text-right text-xs leading-5 text-muted-foreground">
                      {primaryReviewReason.label}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="font-heading text-2xl font-semibold leading-none text-primary tabular-nums">
                    {match.fitScore}%
                  </div>
                  <Progress value={clampPct(match.fitScore)} className="w-28" aria-label="조건 확인도" />
                </>
              )}
            </div>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              조건 {criteria.length} · 충족 {passCount}
              {reviewCount > 0 ? ` · 확인 ${reviewCount}` : ""}
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-primary">
              {open ? "접기" : "조건 자세히 보기"}
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
            </span>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-5 border-t bg-muted/30 px-5 pb-5 pt-4">
            <div className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-muted-foreground">세부 조건</div>
              {criteria.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {criteria.map((chip, index) => (
                    <CriterionRow key={`${chip.dimension}-${index}`} chip={chip} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">표시할 세부 조건이 없어요.</p>
              )}
            </div>

            {disqualificationReason ? (
              <Alert>
                <ShieldQuestion />
                <AlertTitle>결격 여부만 확인하면 추천이 확정됩니다</AlertTitle>
                <AlertDescription>
                  체납·신용·제재 등 결격 사유를 1분 만에 확인하면 이 사업의 적격 여부가 바로 판정됩니다. 자가신고 기준입니다.
                </AlertDescription>
                <AlertAction>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => scrollToDisqualificationCheck()}
                  >
                    1분 결격 확인
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}

            {match.ranking && match.ranking.reasons.length > 0 ? (
              <div className="rounded-md border bg-background px-3 py-2.5">
                <div className="text-xs font-semibold text-muted-foreground">추천 순서 근거</div>
                <ul className="mt-1.5 space-y-1 text-xs leading-5 text-muted-foreground">
                  {match.ranking.reasons.slice(0, 3).map((reason) => (
                    <li key={reason}>· {reason}</li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                  관련성과 준비 우선순위는 선정 가능성을 뜻하지 않아요.
                </p>
              </div>
            ) : null}

            <p className="text-xs leading-5 text-muted-foreground">{writeSupportNote(match.writeSupport)}</p>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs font-semibold text-muted-foreground">이 결과에 대한 피드백</span>
                <MatchFeedbackControls grantId={match.grantId} title={match.title} />
              </div>
              <Button type="button" onClick={() => onPrepare(match.grantId)} disabled={preparing} className="shrink-0">
                {preparing ? "준비 중…" : writeSupportCta(match.writeSupport)}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function scrollToDisqualificationCheck() {
  // 결격 빠른 확인 카드(#next-question)가 있으면 그쪽으로, 없으면 결격 정정 섹션(설정)으로.
  const target =
    document.getElementById("next-question") ?? document.getElementById("company-settings");
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function CriterionRow({ chip }: { chip: RuleTraceChip }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-md)] border bg-card px-4 py-3">
      <span
        className={cn(
          "mt-0.5 flex size-6 flex-none items-center justify-center rounded-full",
          chip.result === "pass" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        <CriterionResultIcon result={chip.result} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={chip.kind === "preferred" ? "secondary" : chip.kind === "exclusion" ? "destructive" : "outline"}
          >
            {criterionKindLabel(chip.kind)}
          </Badge>
          <span className="text-sm font-medium text-foreground">{chip.label}</span>
        </div>
        {chip.companyValue ? <div className="text-xs text-muted-foreground">{chip.companyValue}</div> : null}
        {chip.sourceSpan ? <div className="text-xs leading-5 text-muted-foreground">{chip.sourceSpan}</div> : null}
      </div>
      <span className="flex-none self-center text-xs font-medium text-muted-foreground">
        {criterionResultText(chip.result)}
      </span>
    </div>
  );
}

function CriterionResultIcon({ result }: { result: RuleTraceChipResult }) {
  if (result === "pass") return <Check className="size-3" strokeWidth={3} />;
  if (result === "text_only" || result === "unknown") return <HelpCircle className="size-3.5" />;
  return <Minus className="size-3" strokeWidth={3} />;
}

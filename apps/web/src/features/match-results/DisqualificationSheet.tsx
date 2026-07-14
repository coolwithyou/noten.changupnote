"use client";

import { useMemo, useState } from "react";
import { Check, ChevronLeft } from "lucide-react";
import {
  DISQUALIFICATION_FLAG_LABELS,
  DISQUALIFICATION_QUESTIONS,
  type DisqualificationAxis,
  type DisqualificationFlag,
} from "@cunote/core";
import type { MatchingProfileAnswerRequest, ProductTeaserResult } from "@cunote/contracts";
import { PrecisionGauge } from "@/components/app/precision-gauge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { matchingPrecision, profileRowStatus } from "./logic";

const AXES: readonly DisqualificationAxis[] = ["tax_compliance", "credit_status", "sanction"];

const AXIS_LABELS: Record<DisqualificationAxis, string> = {
  tax_compliance: "세금·보험료 체납",
  credit_status: "신용 문제",
  sanction: "제재·참여 제한",
};

/** 자가신고 안내 캡션(디자인 어휘). 실제 예외(분납·유예) 규칙은 판정 엔진이 소비한다. */
const AXIS_NOTES: Partial<Record<DisqualificationAxis, string>> = {
  tax_compliance: "분납 계획이 승인된 경우 지원 가능한 공고도 있어요",
};

function axisFlags(axis: DisqualificationAxis): DisqualificationFlag[] {
  return DISQUALIFICATION_QUESTIONS.filter((question) => question.axis === axis).flatMap((question) => [
    ...question.covers,
  ]);
}

/** 축 전체 문항을 응답 완료(covers 전체 known)로 묶고, held에 체크된 플래그를 보유로 표기. */
function buildAxisAnswers(
  axis: DisqualificationAxis,
  held: Set<DisqualificationFlag>,
): Record<string, { held: DisqualificationFlag[] }> {
  const answers: Record<string, { held: DisqualificationFlag[] }> = {};
  for (const question of DISQUALIFICATION_QUESTIONS) {
    if (question.axis !== axis) continue;
    answers[question.id] = { held: question.covers.filter((flag) => held.has(flag)) };
  }
  return answers;
}

/**
 * 결격 확인 시트(7d) — 내 정보 시트 위에서 뷰 전환으로 들어오는 한 겹 더 깊은 확인 플로우.
 * 3축 각각 "해당 없음" 일괄 확인 또는 개별 플래그 자가신고. 3축 모두 known이 되면 완료 컷.
 */
export function DisqualificationSheet({
  teaser,
  onAnswer,
  submitting,
  onBack,
  onClose,
}: {
  teaser: ProductTeaserResult;
  onAnswer: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  submitting: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const [held, setHeld] = useState<Set<DisqualificationFlag>>(new Set());
  const [expandedAxis, setExpandedAxis] = useState<DisqualificationAxis | null>(null);
  // 시트 진입 시점의 정밀도를 기준선으로 잡아 완료 컷에서 delta를 표기한다.
  const [baselinePct] = useState(() => matchingPrecision(teaser).pct);

  const statuses = useMemo(
    () =>
      Object.fromEntries(AXES.map((axis) => [axis, profileRowStatus(teaser, axis)])) as Record<
        DisqualificationAxis,
        ReturnType<typeof profileRowStatus>
      >,
    [teaser],
  );
  const allKnown = AXES.every((axis) => statuses[axis] === "known");
  const precision = matchingPrecision(teaser);
  const delta = precision.pct - baselinePct;

  function toggleFlag(flag: DisqualificationFlag, checked: boolean) {
    setHeld((current) => {
      const next = new Set(current);
      if (checked) next.add(flag);
      else next.delete(flag);
      return next;
    });
  }

  async function saveAxis(axis: DisqualificationAxis, heldSet: Set<DisqualificationFlag>) {
    await onAnswer({ field: axis, value: { answers: buildAxisAnswers(axis, heldSet) }, mode: "replace" });
    setExpandedAxis(null);
  }

  function markNone(axis: DisqualificationAxis) {
    const next = new Set(held);
    for (const flag of axisFlags(axis)) next.delete(flag);
    setHeld(next);
    void saveAxis(axis, next);
  }

  return (
    <>
      <SheetHeader className="flex-row items-center gap-1 px-6 pt-6 pb-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="내 사업자 정보로 돌아가기"
          onClick={onBack}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <div>
          <SheetTitle className="text-lg font-extrabold">결격 여부 확인</SheetTitle>
          <SheetDescription className="sr-only">
            체납·신용·제재 결격 여부를 자가신고 기준으로 확인합니다.
          </SheetDescription>
        </div>
      </SheetHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pt-4 pb-6">
          {allKnown ? (
            <CompletionView pct={precision.pct} delta={delta} onClose={onClose} />
          ) : (
            <>
              <div className="rounded-[14px] bg-surface-soft px-4 py-3.5">
                <p className="text-[13.5px] leading-relaxed text-text-nav">
                  대부분의 회사는 해당사항이 없어요. 없다면 한 번에 확인을 끝낼 수 있어요.
                </p>
                <p className="mt-1.5 text-[11.5px] text-text-tertiary">자가신고 기준이에요</p>
              </div>
              <div className="mt-4 flex flex-col gap-2.5">
                {AXES.map((axis) => (
                  <AxisCard
                    key={axis}
                    axis={axis}
                    known={statuses[axis] === "known"}
                    held={held}
                    expanded={expandedAxis === axis}
                    submitting={submitting}
                    onToggleExpand={() =>
                      setExpandedAxis((current) => (current === axis ? null : axis))
                    }
                    onToggleFlag={toggleFlag}
                    onMarkNone={() => markNone(axis)}
                    onSave={() => void saveAxis(axis, held)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

function AxisCard({
  axis,
  known,
  held,
  expanded,
  submitting,
  onToggleExpand,
  onToggleFlag,
  onMarkNone,
  onSave,
}: {
  axis: DisqualificationAxis;
  known: boolean;
  held: Set<DisqualificationFlag>;
  expanded: boolean;
  submitting: boolean;
  onToggleExpand: () => void;
  onToggleFlag: (flag: DisqualificationFlag, checked: boolean) => void;
  onMarkNone: () => void;
  onSave: () => void;
}) {
  const flags = axisFlags(axis);
  const note = AXIS_NOTES[axis];

  if (known) {
    return (
      <div className="flex items-center gap-2.5 rounded-[14px] bg-brand-mint-soft px-4 py-3.5">
        <Check className="size-3.5 shrink-0 text-brand-mint" strokeWidth={3} aria-hidden />
        <span className="flex-1 text-sm font-bold text-ink">{AXIS_LABELS[axis]}</span>
        <span className="text-[12.5px] font-bold text-brand-mint-ink">확인됨 ✓</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[14px] border px-4 py-3.5",
        expanded ? "border-border-card-hover bg-surface-brand" : "border-border-card",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex-1 text-[14.5px] font-bold text-ink">{AXIS_LABELS[axis]}</span>
        {expanded ? (
          <Button type="button" variant="ghost" size="xs" onClick={onToggleExpand} disabled={submitting}>
            접기
          </Button>
        ) : (
          <Button type="button" variant="brand-soft" size="sm" onClick={onMarkNone} disabled={submitting}>
            해당 없음
          </Button>
        )}
      </div>

      {expanded ? (
        <div className="mt-3 flex flex-col gap-2.5">
          <FieldGroup className="gap-2">
            {flags.map((flag) => (
              <Field key={flag} orientation="horizontal">
                <Checkbox
                  id={`disq-${flag}`}
                  checked={held.has(flag)}
                  disabled={submitting}
                  onCheckedChange={(checked) => onToggleFlag(flag, checked === true)}
                />
                <FieldLabel htmlFor={`disq-${flag}`}>{DISQUALIFICATION_FLAG_LABELS[flag]}</FieldLabel>
              </Field>
            ))}
          </FieldGroup>
          {note ? <p className="text-[12px] text-text-tertiary">{note}</p> : null}
          <Button type="button" size="sm" className="w-full" onClick={onSave} disabled={submitting}>
            {submitting ? "저장 중" : "저장"}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="mt-1.5 h-auto px-0 font-normal text-text-tertiary"
          onClick={onToggleExpand}
          disabled={submitting}
        >
          해당사항이 있어요 ▸
        </Button>
      )}
    </div>
  );
}

function CompletionView({ pct, delta, onClose }: { pct: number; delta: number; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center pt-4 text-center">
      <div className="flex size-[52px] items-center justify-center rounded-full bg-brand-mint text-2xl font-extrabold text-white shadow-[var(--shadow-mint-check)]">
        ✓
      </div>
      <p className="mt-4 text-[19px] font-extrabold text-ink">결격 여부 확인 완료 ✓</p>
      <div className="mt-5 w-full rounded-[14px] border border-brand-tint bg-landing-step-blue px-4 py-3.5 text-left shadow-[var(--shadow-landing-step)]">
        <PrecisionGauge
          pct={pct}
          label={`매칭 정밀도 ${pct}%`}
          caption="확인한 만큼 판정이 정확해져요"
          meta=""
          {...(delta > 0 ? { delta: `+${delta}%p` } : {})}
        />
      </div>
      <Button type="button" className="mt-4 w-full" onClick={onClose}>
        바뀐 결과 보기
      </Button>
    </div>
  );
}

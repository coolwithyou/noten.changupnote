"use client";

import { useState } from "react";
import { Check, ChevronLeft } from "lucide-react";
import type {
  MatchingProfileAnswerRequest,
  PriorAwardSelfKind,
  PriorAwardState,
  ProductTeaserResult,
} from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  buildPriorAwardProfileValue,
  emptyPriorAwardSettingsDraft,
  PRIOR_AWARD_PROGRAM_OPTIONS,
  type PriorAwardSettingsDraft,
  type PriorAwardTriState,
} from "@/features/dashboard/priorAwardSettings";

// 백엔드 self kind와 1:1로 대응하는 구어체 질문(디자인 톤). BI(창업보육센터) 입주는
// self kind가 아니라 has_incubation_tenancy 필드로 저장되어 별도 블록으로 묻는다.
const SELF_QUESTIONS: Array<{ kind: PriorAwardSelfKind; question: string }> = [
  { kind: "current_similar", question: "지금 다른 정부지원사업을 수행하고 있나요?" },
  { kind: "same_year_other_support", question: "올해 비슷한 지원을 다른 기관에서 받았나요?" },
  { kind: "same_project", question: "같은 과제로 다른 지원을 함께 받고 있나요?" },
  { kind: "same_business_prior", question: "이 사업에 예전에 선정되거나 입상한 적이 있나요?" },
];

const TRI_STATE_ITEMS: Array<{ value: PriorAwardTriState; label: string }> = [
  { value: "yes", label: "예" },
  { value: "no", label: "아니요" },
  { value: "unknown", label: "모름" },
];

const STATE_ITEMS: Array<{ value: PriorAwardState; label: string }> = [
  { value: "participating", label: "참여 중" },
  { value: "completed", label: "선정·수혜 완료" },
  { value: "graduated", label: "수료·졸업" },
];

/**
 * 수혜 이력 시트(7e) — 자가 문항(4종) + 대표 사업 칩 선택·상태/연도 입력.
 * 저장은 prior_award 차원 replace로 onAnswer 경로를 재사용한다(대시보드 헬퍼 공유).
 */
export function PriorAwardSheet({
  onAnswer,
  submitting,
  onBack,
}: {
  teaser: ProductTeaserResult;
  onAnswer: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  submitting: boolean;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<PriorAwardSettingsDraft>(() => emptyPriorAwardSettingsDraft());
  const [error, setError] = useState<string | null>(null);

  function setSelf(kind: PriorAwardSelfKind, value: PriorAwardTriState) {
    setDraft((current) => ({ ...current, self: { ...current.self, [kind]: value } }));
  }

  function toggleProgram(key: string, label: string) {
    setDraft((current) => {
      const exists = current.records.some((record) => record.id === key);
      if (exists) {
        return { ...current, records: current.records.filter((record) => record.id !== key) };
      }
      return {
        ...current,
        records: [
          ...current.records,
          { id: key, program: label, agency: "", state: "completed" as PriorAwardState, year: "" },
        ],
      };
    });
  }

  function updateProgram(key: string, patch: { state?: PriorAwardState; year?: string }) {
    setDraft((current) => ({
      ...current,
      records: current.records.map((record) => (record.id === key ? { ...record, ...patch } : record)),
    }));
  }

  async function save(next: PriorAwardSettingsDraft) {
    setError(null);
    let value;
    try {
      value = buildPriorAwardProfileValue(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "수혜 이력을 저장하지 못했습니다.");
      return;
    }
    await onAnswer({ field: "prior_award", value, mode: "replace" });
    onBack();
  }

  // 명시적 "예" 답변이나 선택된 사업이 있으면 일괄 "해당 없음" 확인으로 덮어쓰지 않는다.
  const hasPositiveAnswer =
    draft.records.length > 0 ||
    draft.incubationTenancy === "yes" ||
    SELF_QUESTIONS.some(({ kind }) => draft.self[kind] === "yes");

  function saveNone() {
    // "받아본 적 없어요" — 자가 문항 전부 해당 없음, 대표 사업 전부 확인(이력 없음).
    const cleared: PriorAwardSettingsDraft = {
      self: {
        current_similar: "no",
        same_project: "no",
        same_business_prior: "no",
        same_year_other_support: "no",
      },
      incubationTenancy: "no",
      records: [],
      knownPrograms: PRIOR_AWARD_PROGRAM_OPTIONS.filter((option) => !option.isProgramType).map(
        (option) => option.key,
      ),
      knownProgramTypes: PRIOR_AWARD_PROGRAM_OPTIONS.filter((option) => option.isProgramType).map(
        (option) => option.key,
      ),
    };
    void save(cleared);
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
          <SheetTitle className="text-lg font-extrabold">지원사업 수혜 이력</SheetTitle>
          <SheetDescription className="sr-only">
            과거 정부지원사업 수혜·참여 이력을 자가신고 기준으로 확인합니다.
          </SheetDescription>
        </div>
      </SheetHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pt-4 pb-6">
          <div className="flex flex-col gap-4">
            {SELF_QUESTIONS.map(({ kind, question }) => (
              <div key={kind}>
                <p className="text-sm font-semibold text-ink">{question}</p>
                <ToggleGroup
                  aria-label={question}
                  className="mt-2 w-fit"
                  variant="outline"
                  spacing={1}
                  value={[draft.self[kind]]}
                  onValueChange={(next) => {
                    const [selected] = next;
                    if (selected === "yes" || selected === "no" || selected === "unknown") {
                      setSelf(kind, selected);
                    }
                  }}
                >
                  {TRI_STATE_ITEMS.map((item) => (
                    <ToggleGroupItem key={item.value} value={item.value}>
                      {item.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ))}

            <div>
              <p className="text-sm font-semibold text-ink">창업보육센터(BI)에 입주해 있나요?</p>
              <ToggleGroup
                aria-label="창업보육센터(BI) 입주 여부"
                className="mt-2 w-fit"
                variant="outline"
                spacing={1}
                value={[draft.incubationTenancy]}
                onValueChange={(next) => {
                  const [selected] = next;
                  if (selected === "yes" || selected === "no" || selected === "unknown") {
                    setDraft((current) => ({ ...current, incubationTenancy: selected }));
                  }
                }}
              >
                {TRI_STATE_ITEMS.map((item) => (
                  <ToggleGroupItem key={item.value} value={item.value}>
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>

          <p className="mt-6 text-[13.5px] font-extrabold text-text-nav">받아본 사업이 있다면 선택하세요</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {PRIOR_AWARD_PROGRAM_OPTIONS.map((option) => {
              const selected = draft.records.some((record) => record.id === option.key);
              return (
                <Button
                  key={option.key}
                  type="button"
                  size="sm"
                  variant={selected ? "brand-soft" : "outline"}
                  className="rounded-full"
                  disabled={submitting}
                  onClick={() => toggleProgram(option.key, option.label)}
                >
                  {selected ? <Check data-icon="inline-start" strokeWidth={3} aria-hidden /> : null}
                  {option.label}
                </Button>
              );
            })}
          </div>

          {draft.records.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2.5">
              {draft.records.map((record) => (
                <div
                  key={record.id}
                  className="rounded-[14px] border border-border-brand-soft bg-surface-brand px-4 py-3.5"
                >
                  <p className="text-[13px] font-bold text-brand-hover">{record.program}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <ToggleGroup
                      aria-label={`${record.program} 상태`}
                      className="w-fit"
                      variant="outline"
                      size="sm"
                      spacing={1}
                      value={[record.state]}
                      onValueChange={(next) => {
                        const [selected] = next;
                        if (
                          selected === "participating" ||
                          selected === "completed" ||
                          selected === "graduated"
                        ) {
                          updateProgram(record.id, { state: selected });
                        }
                      }}
                    >
                      {STATE_ITEMS.map((item) => (
                        <ToggleGroupItem key={item.value} value={item.value}>
                          {item.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <div className="flex items-center gap-1.5">
                      <Input
                        aria-label={`${record.program} 연도`}
                        inputMode="numeric"
                        placeholder="연도"
                        value={record.year}
                        disabled={submitting}
                        className="h-8 w-[68px] rounded-lg px-3 py-1 text-center text-sm tabular-nums shadow-none"
                        onChange={(event) =>
                          updateProgram(record.id, {
                            year: event.currentTarget.value.replace(/\D/g, "").slice(0, 4),
                          })
                        }
                      />
                      <span className="text-[12.5px] text-text-secondary">년</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 text-xs text-destructive" aria-live="polite">
              {error}
            </p>
          ) : null}
        </div>
      </ScrollArea>

      <SheetFooter className="gap-2 border-t border-border-subtle px-6 py-4">
        <Button type="button" className="w-full" onClick={() => void save(draft)} disabled={submitting}>
          {submitting ? "저장 중" : "저장"}
        </Button>
        <Button
          type="button"
          variant="brand-outline"
          className="w-full"
          onClick={saveNone}
          disabled={submitting || hasPositiveAnswer}
        >
          받아본 적 없어요 — 확인 완료
        </Button>
        <p className="text-center text-[12px] text-text-tertiary">
          자가신고 기준이에요 · 확인한 만큼 판정이 정확해져요
        </p>
      </SheetFooter>
    </>
  );
}

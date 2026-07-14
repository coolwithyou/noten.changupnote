"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  MatchingProfileAnswerRequest,
  NextQuestionDto,
  PriorAwardState,
} from "@cunote/contracts";
import {
  DISQUALIFICATION_FLAG_LABELS,
  type DisqualificationFlag,
} from "@cunote/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  buildDisqualificationAnswers,
  buildNumberGroupValue,
  buildPriorAwardQuestionValue,
  defaultQuestionValue,
  numberGroupSpec,
  parseQuestionValue,
  selectedQuestionRange,
  shouldMergeQuestionValue,
} from "@/features/profile-questions/questionAnswer";

export function TeaserQuestionForm({
  question,
  onAnswer,
  submitting,
  variant = "default",
}: {
  question: NextQuestionDto;
  onAnswer: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  submitting: boolean;
  variant?: "default" | "spotlight";
}) {
  const [scalar, setScalar] = useState(() => defaultQuestionValue(question));
  const [held, setHeld] = useState<Set<DisqualificationFlag>>(new Set());
  const [group, setGroup] = useState<Record<string, string>>({});
  const [priorAnswer, setPriorAnswer] = useState<"true" | "false" | "">("");
  const [priorState, setPriorState] = useState<PriorAwardState | "">(
    question.priorAwardContext?.states?.length === 1 ? question.priorAwardContext.states[0]! : "",
  );
  const [priorYear, setPriorYear] = useState("");
  const [message, setMessage] = useState("");
  const flags = useMemo(
    () => (question.options ?? []).filter(isDisqualificationFlag),
    [question.options],
  );

  useEffect(() => {
    setScalar(defaultQuestionValue(question));
    setHeld(new Set());
    setGroup({});
    setPriorAnswer("");
    setPriorState(
      question.priorAwardContext?.states?.length === 1 ? question.priorAwardContext.states[0]! : "",
    );
    setPriorYear("");
    setMessage("");
  }, [question]);

  async function applyValue(value: unknown, mode?: "replace" | "merge") {
    setMessage("");
    try {
      await onAnswer({
        field: question.dimension,
        value,
        ...(mode ? { mode } : {}),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "답변을 반영하지 못했습니다.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (question.dimension === "prior_award" && question.priorAwardContext) {
      const context = question.priorAwardContext;
      const needsRecord = context.scope !== "self" && priorAnswer === "true";
      if (!priorAnswer) {
        setMessage("예 또는 아니오를 선택해 주세요.");
        return;
      }
      if (needsRecord && !priorState) {
        setMessage("참여·수혜 상태를 선택해 주세요.");
        return;
      }
      const parsedYear = priorYear.trim() ? Number(priorYear) : undefined;
      if (
        needsRecord &&
        context.requiresYear &&
        (!Number.isInteger(parsedYear) || parsedYear! < 1900 || parsedYear! > 2100)
      ) {
        setMessage("판정에 필요한 수혜 연도(YYYY)를 입력해 주세요.");
        return;
      }
      await applyValue(
        buildPriorAwardQuestionValue(context, {
          hasHistory: priorAnswer === "true",
          ...(priorState ? { state: priorState } : {}),
          ...(parsedYear !== undefined ? { year: parsedYear } : {}),
        }),
        "merge",
      );
      return;
    }
    if (question.inputType === "checklist") {
      await applyValue({ answers: buildDisqualificationAnswers(question.dimension, flags, [...held]) });
      return;
    }
    if (question.inputType === "number_group") {
      const value = buildNumberGroupValue(question.dimension, group);
      if (!value) {
        setMessage("최소 한 개 항목을 입력해 주세요.");
        return;
      }
      await applyValue(value);
      return;
    }
    if (!scalar.trim()) {
      setMessage("값을 입력하거나 선택해 주세요.");
      return;
    }
    const range = selectedQuestionRange(question, scalar);
    if (range) {
      await onAnswer({
        field: question.dimension,
        range: { min: range.min, max: range.max, unit: range.unit },
      });
      return;
    }
    await applyValue(
      parseQuestionValue(question, scalar),
      shouldMergeQuestionValue(question, scalar) ? "merge" : undefined,
    );
  }

  async function submitUnknown() {
    setMessage("");
    try {
      await onAnswer({ field: question.dimension, unknown: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "모름 상태를 반영하지 못했습니다.");
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {question.dimension === "prior_award" && question.priorAwardContext ? (
        <PriorAwardInputs
          question={question}
          answer={priorAnswer}
          state={priorState}
          year={priorYear}
          disabled={submitting}
          onAnswerChange={setPriorAnswer}
          onStateChange={setPriorState}
          onYearChange={setPriorYear}
        />
      ) : variant === "spotlight" && question.inputType === "boolean" ? (
        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            disabled={submitting}
            onClick={() => void applyValue(true)}
            className="min-w-0 flex-1 text-base sm:flex-none sm:px-11"
          >
            예
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => void applyValue(false)}
            className="min-w-0 flex-1 border-border-card-hover bg-card text-base text-brand-hover sm:flex-none sm:px-8"
          >
            아니요
          </Button>
          <Button
            type="button"
            variant="link"
            disabled={submitting}
            onClick={() => void submitUnknown()}
            className="h-auto px-1 text-[13px] font-medium text-text-secondary underline"
          >
            모름
          </Button>
        </div>
      ) : question.inputType === "checklist" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {flags.map((flag) => (
            <label key={flag} className="flex items-center gap-2 rounded-lg border bg-background/70 p-3 text-sm">
              <Checkbox
                checked={held.has(flag)}
                disabled={submitting}
                onCheckedChange={(checked) => setHeld((current) => {
                  const next = new Set(current);
                  if (checked === true) next.add(flag);
                  else next.delete(flag);
                  return next;
                })}
              />
              {DISQUALIFICATION_FLAG_LABELS[flag]}
            </label>
          ))}
        </div>
      ) : question.inputType === "number_group" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {numberGroupSpec(question.dimension).map((item) => (
            <label key={item.name} className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">{item.label}</span>
              {item.type === "boolean" ? (
                <ToggleGroup
                  value={group[item.name] ? [group[item.name]!] : []}
                  onValueChange={(values) => {
                    const [value] = values;
                    if (value) setGroup((current) => ({ ...current, [item.name]: value }));
                  }}
                  variant="outline"
                  spacing={1}
                >
                  <ToggleGroupItem value="true">예</ToggleGroupItem>
                  <ToggleGroupItem value="false">아니오</ToggleGroupItem>
                </ToggleGroup>
              ) : (
                <Input
                  type="number"
                  inputMode={item.allowNegative ? "text" : "numeric"}
                  min={item.allowNegative ? undefined : 0}
                  step={item.step}
                  placeholder={item.placeholder}
                  value={group[item.name] ?? ""}
                  disabled={submitting}
                  onChange={(event) => setGroup((current) => ({ ...current, [item.name]: event.currentTarget.value }))}
                />
              )}
              {item.hint ? <span className="text-xs text-muted-foreground">{item.hint}</span> : null}
            </label>
          ))}
        </div>
      ) : (
        <ScalarInput question={question} value={scalar} onChange={setScalar} disabled={submitting} />
      )}

      {variant === "spotlight" && question.inputType === "boolean" && question.dimension !== "prior_award" ? null : (
        <div className="flex flex-wrap gap-2">
          {question.inputType === "checklist" ? (
          <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={() => {
            setHeld(new Set());
            void applyValue({ answers: buildDisqualificationAnswers(question.dimension, flags, []) });
          }}>
            해당사항 없음
          </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "반영 중" : "답변 반영"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={() => void submitUnknown()}>
            모름
          </Button>
        </div>
      )}
      {message ? <p className="text-sm text-destructive" aria-live="polite">{message}</p> : null}
      <p className="text-xs text-text-tertiary">자가신고 기준이에요 · 모름을 누르면 30일간 다시 묻지 않아요</p>
    </form>
  );
}

const PRIOR_AWARD_STATE_OPTIONS: Array<{ value: PriorAwardState; label: string }> = [
  { value: "participating", label: "참여 중" },
  { value: "completed", label: "수혜 완료" },
  { value: "graduated", label: "수료" },
];

function PriorAwardInputs({
  question,
  answer,
  state,
  year,
  disabled,
  onAnswerChange,
  onStateChange,
  onYearChange,
}: {
  question: NextQuestionDto;
  answer: "true" | "false" | "";
  state: PriorAwardState | "";
  year: string;
  disabled: boolean;
  onAnswerChange: (value: "true" | "false" | "") => void;
  onStateChange: (value: PriorAwardState | "") => void;
  onYearChange: (value: string) => void;
}) {
  const context = question.priorAwardContext!;
  const needsRecord = context.scope !== "self" && answer === "true";
  const fixedState = context.states?.length === 1 ? context.states[0] : undefined;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">해당 여부</span>
        <ToggleGroup
          aria-label={question.prompt}
          value={[answer]}
          disabled={disabled}
          onValueChange={(values) => {
            const [next] = values;
            if (next === "true" || next === "false") onAnswerChange(next);
          }}
          variant="outline"
          spacing={1}
        >
          <ToggleGroupItem value="true">예</ToggleGroupItem>
          <ToggleGroupItem value="false">아니오</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {needsRecord ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">이력 상태</span>
            <Select
              items={PRIOR_AWARD_STATE_OPTIONS}
              value={state}
              disabled={Boolean(fixedState) || disabled}
              onValueChange={(value) => {
                if (value === "participating" || value === "completed" || value === "graduated") {
                  onStateChange(value);
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="상태를 선택해 주세요" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PRIOR_AWARD_STATE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {context.requiresYear ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">수혜 연도</span>
              <Input
                inputMode="numeric"
                maxLength={4}
                placeholder="2025"
                value={year}
                disabled={disabled}
                onChange={(event) => onYearChange(event.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ScalarInput({
  question,
  value,
  onChange,
  disabled,
}: {
  question: NextQuestionDto;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  if (question.inputType === "select" && (question.options?.length || question.rangeOptions?.length)) {
    const items = question.responseStage === "range" && question.rangeOptions?.length
      ? question.rangeOptions.map((option) => ({ label: option.label, value: option.value }))
      : (question.options ?? []).map((option) => ({ label: option, value: option }));
    return (
      <Select
        items={items}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger className="w-full"><SelectValue placeholder="선택해 주세요" /></SelectTrigger>
        <SelectContent><SelectGroup>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    );
  }
  if (question.inputType === "boolean") {
    return (
      <ToggleGroup
        value={[value]}
        onValueChange={(values) => {
          const [next] = values;
          if (next) onChange(next);
        }}
        variant="outline"
        spacing={1}
      >
        <ToggleGroupItem value="true">예</ToggleGroupItem>
        <ToggleGroupItem value="false">아니오</ToggleGroupItem>
      </ToggleGroup>
    );
  }
  return (
    <Input
      type={question.inputType === "number" ? "number" : "text"}
      inputMode={question.inputType === "number" ? "numeric" : "text"}
      min={question.inputType === "number" ? 0 : undefined}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function isDisqualificationFlag(value: string): value is DisqualificationFlag {
  return value in DISQUALIFICATION_FLAG_LABELS;
}

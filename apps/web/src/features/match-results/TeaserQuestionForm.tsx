"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { CompanyProfile, NextQuestionDto } from "@cunote/contracts";
import {
  DISQUALIFICATION_FLAG_LABELS,
  markProfileQuestionUnknown,
  updateCompanyProfileField,
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
  SELF_DECLARED_CONFIDENCE,
  buildDisqualificationAnswers,
  buildNumberGroupValue,
  defaultQuestionValue,
  numberGroupSpec,
  parseQuestionValue,
  shouldMergeQuestionValue,
} from "@/features/profile-questions/questionAnswer";

export function TeaserQuestionForm({
  question,
  currentProfile,
  onProfileSubmit,
  submitting,
}: {
  question: NextQuestionDto;
  currentProfile: CompanyProfile;
  onProfileSubmit: (profile: CompanyProfile) => Promise<void>;
  submitting: boolean;
}) {
  const [scalar, setScalar] = useState(() => defaultQuestionValue(question));
  const [held, setHeld] = useState<Set<DisqualificationFlag>>(new Set());
  const [group, setGroup] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const flags = useMemo(
    () => (question.options ?? []).filter(isDisqualificationFlag),
    [question.options],
  );

  async function applyValue(value: unknown, mode?: "replace" | "merge") {
    setMessage("");
    try {
      const next = updateCompanyProfileField(currentProfile, {
        field: question.dimension,
        value,
        confidence: SELF_DECLARED_CONFIDENCE,
        ...(mode ? { mode } : {}),
        sourceKind: "self_declared",
        provider: "cunote_teaser_manual",
        asOf: new Date().toISOString(),
      });
      await onProfileSubmit(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "답변을 반영하지 못했습니다.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    await applyValue(
      parseQuestionValue(question, scalar),
      shouldMergeQuestionValue(question, scalar) ? "merge" : undefined,
    );
  }

  async function submitUnknown() {
    setMessage("");
    try {
      const next = markProfileQuestionUnknown({
        profile: currentProfile,
        dimension: question.dimension,
        answeredAt: new Date(),
        ttlDays: 30,
      });
      await onProfileSubmit(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "모름 상태를 반영하지 못했습니다.");
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {question.inputType === "checklist" ? (
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
      {message ? <p className="text-sm text-destructive" aria-live="polite">{message}</p> : null}
      <p className="text-xs text-muted-foreground">자가신고 기준이며, 모름을 선택하면 30일 동안 같은 질문을 다시 묻지 않습니다.</p>
    </form>
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
  if (question.inputType === "select" && question.options?.length) {
    const items = question.options.map((option) => ({ label: option, value: option }));
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

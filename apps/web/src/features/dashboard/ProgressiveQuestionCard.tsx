"use client";

import type {
  ActionResult,
  CompanyInitialMatchResult,
  CompanyProfile,
  CriterionDimension,
  NextQuestionDto,
  PriorAwardState,
  ProfileQuestionEventReceiptDto,
  ProfileQuestionRefreshDto,
} from "@cunote/contracts";
import {
  DISQUALIFICATION_FLAG_LABELS,
  type ProfileUpdateImpact,
  type DisqualificationFlag,
} from "@cunote/core";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  SELF_DECLARED_CONFIDENCE,
  buildDisqualificationAnswers,
  buildNumberGroupValue,
  buildPriorAwardQuestionValue,
  defaultQuestionValue,
  numberGroupSpec,
  parseQuestionValue,
  selectedQuestionRange,
  shouldMergeQuestionValue,
} from "@/features/profile-questions/questionAnswer";

interface ProfileFieldResult {
  profile: CompanyProfile;
  impact: ProfileUpdateImpact;
  refresh: ProfileQuestionRefreshDto;
  event: ProfileQuestionEventReceiptDto;
  initialMatch: CompanyInitialMatchResult;
}

async function saveProfileField(body: {
  field: CriterionDimension;
  value?: unknown;
  confidence?: number;
  mode?: "replace" | "merge";
  unknown?: boolean;
  range?: { min: number; max: number | null; unit: "krw" | "people" };
}): Promise<ProfileFieldResult> {
  const response = await fetch("/api/web/profile/field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as ActionResult<ProfileFieldResult>;
  if (!response.ok || !result.ok) {
    throw new Error(result.error?.message ?? "저장하지 못했습니다.");
  }
  if (!result.data) throw new Error("저장 결과를 확인하지 못했습니다.");
  return result.data;
}

export function ProgressiveQuestionCard({ question }: { question: NextQuestionDto }) {
  return (
    <Card id="next-question">
      <CardHeader>
        <CardTitle>{question.prompt}</CardTitle>
        <CardDescription>{question.framing}</CardDescription>
        <CardAction>
          <StatusBadge tone="warning">{question.affectedGrantCount}건 영향</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {question.dimension === "prior_award" && question.priorAwardContext ? (
          <PriorAwardQuestionForm question={question} />
        ) : question.inputType === "checklist" ? (
          <DisqualificationChecklistForm question={question} />
        ) : question.inputType === "number_group" ? (
          <NumberGroupForm question={question} />
        ) : (
          <ScalarQuestionForm question={question} />
        )}
        <p className="text-xs text-muted-foreground">자가신고 기준으로 저장됩니다.</p>
      </CardContent>
    </Card>
  );
}

function PriorAwardQuestionForm({ question }: { question: NextQuestionDto }) {
  const router = useRouter();
  const context = question.priorAwardContext!;
  const fixedState = context.states?.length === 1 ? context.states[0] : undefined;
  const [answer, setAnswer] = useState<"true" | "false" | "">("");
  const [state, setState] = useState<PriorAwardState | "">(fixedState ?? "");
  const [year, setYear] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");
  const needsRecord = context.scope !== "self" && answer === "true";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!answer) {
      setStatus("error");
      setMessage("예 또는 아니오를 선택해 주세요.");
      return;
    }
    if (needsRecord && !state) {
      setStatus("error");
      setMessage("참여·수혜 상태를 선택해 주세요.");
      return;
    }
    const parsedYear = year.trim() ? Number(year) : undefined;
    if (needsRecord && context.requiresYear && (!Number.isInteger(parsedYear) || parsedYear! < 1900 || parsedYear! > 2100)) {
      setStatus("error");
      setMessage("판정에 필요한 수혜 연도(YYYY)를 입력해 주세요.");
      return;
    }
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({
        field: "prior_award",
        value: buildPriorAwardQuestionValue(context, {
          hasHistory: answer === "true",
          ...(state ? { state } : {}),
          ...(parsedYear !== undefined ? { year: parsedYear } : {}),
        }),
        confidence: SELF_DECLARED_CONFIDENCE,
        mode: "merge",
      });
      setStatus("idle");
      setMessage(impactMessage(result.impact, result.initialMatch, result.refresh));
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  async function submitUnknown() {
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({ field: "prior_award", unknown: true });
      setStatus("idle");
      setMessage(`모름으로 기록했습니다. 같은 질문은 30일 동안 다시 묻지 않을게요. ${impactMessage(result.impact, result.initialMatch, result.refresh)}`);
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field>
        <FieldLabel>{context.scope === "self" ? "해당 여부" : "참여·수혜·수료 이력"}</FieldLabel>
        <ToggleGroup
          aria-label={question.prompt}
          className="w-fit"
          value={[answer]}
          onValueChange={(next) => {
            const [selected] = next;
            if (selected === "true" || selected === "false") setAnswer(selected);
          }}
          variant="outline"
          spacing={1}
        >
          <ToggleGroupItem value="true">예</ToggleGroupItem>
          <ToggleGroupItem value="false">아니오</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {needsRecord ? (
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>이력 상태</FieldLabel>
            <Select
              aria-label="이력 상태"
              items={PRIOR_AWARD_STATE_OPTIONS}
              value={state}
              disabled={Boolean(fixedState) || status === "saving"}
              onValueChange={(value) => {
                if (value === "participating" || value === "completed" || value === "graduated") setState(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="상태를 선택해 주세요" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PRIOR_AWARD_STATE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="prior-award-year">수혜·참여 연도{context.requiresYear ? " (필수)" : " (선택)"}</FieldLabel>
            <Input
              id="prior-award-year"
              type="number"
              inputMode="numeric"
              min={1900}
              max={2100}
              placeholder="예: 2025"
              value={year}
              disabled={status === "saving"}
              onChange={(event) => setYear(event.currentTarget.value)}
            />
            {context.requiresYear ? <FieldDescription>최근 N년 조건 판정에 필요합니다.</FieldDescription> : null}
          </Field>
        </FieldGroup>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={status === "saving"}>
          {status === "saving" ? <Spinner data-icon="inline-start" /> : null}
          {status === "saving" ? "저장 중" : "저장"}
        </Button>
        <Button type="button" variant="ghost" disabled={status === "saving"} onClick={() => void submitUnknown()}>
          모름
        </Button>
      </div>
      <p className={status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"} aria-live="polite">
        {message}
      </p>
    </form>
  );
}

const PRIOR_AWARD_STATE_OPTIONS: Array<{ value: PriorAwardState; label: string }> = [
  { value: "participating", label: "현재 참여·수행 중" },
  { value: "completed", label: "선정·수혜 완료" },
  { value: "graduated", label: "교육·프로그램 수료" },
];

// ── 결격 그룹 체크리스트(C1) — "해당사항 없음" 일괄 처리 ─────────────────────────
function DisqualificationChecklistForm({ question }: { question: NextQuestionDto }) {
  const router = useRouter();
  const flags = useMemo(
    () => (question.options ?? []).filter(isDisqualificationFlag),
    [question.options],
  );
  const [held, setHeld] = useState<Set<DisqualificationFlag>>(new Set());
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  function toggle(flag: DisqualificationFlag, checked: boolean) {
    setHeld((current) => {
      const next = new Set(current);
      if (checked) next.add(flag);
      else next.delete(flag);
      return next;
    });
  }

  async function submit(heldFlags: DisqualificationFlag[]) {
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({
        field: question.dimension,
        value: { answers: buildDisqualificationAnswers(question.dimension, flags, heldFlags) },
        confidence: SELF_DECLARED_CONFIDENCE,
      });
      setStatus("idle");
      setMessage(impactMessage(result.impact, result.initialMatch, result.refresh));
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  async function submitUnknown() {
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({ field: question.dimension, unknown: true });
      setStatus("idle");
      setMessage(`모름으로 기록했습니다. 같은 질문은 30일 동안 다시 묻지 않을게요. ${impactMessage(result.impact, result.initialMatch, result.refresh)}`);
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit([...held]);
      }}
    >
      <FieldGroup className="grid gap-2 sm:grid-cols-2">
        {flags.map((flag) => (
          <Field key={flag} orientation="horizontal" className="rounded-[var(--radius-md)] border bg-muted/20 p-3">
            <Checkbox
              id={`disq-${flag}`}
              checked={held.has(flag)}
              disabled={status === "saving"}
              onCheckedChange={(checked) => toggle(flag, checked === true)}
            />
            <FieldLabel htmlFor={`disq-${flag}`}>{DISQUALIFICATION_FLAG_LABELS[flag]}</FieldLabel>
          </Field>
        ))}
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={status === "saving"}
          onClick={() => {
            setHeld(new Set());
            void submit([]);
          }}
        >
          해당사항 없음
        </Button>
        <Button type="submit" disabled={status === "saving"}>
          {status === "saving" ? <Spinner data-icon="inline-start" /> : null}
          {status === "saving" ? "저장 중" : "선택 항목 저장"}
        </Button>
        <Button type="button" variant="ghost" disabled={status === "saving"} onClick={() => void submitUnknown()}>
          모름
        </Button>
      </div>
      <p
        className={status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}

// ── 재무·고용·투자 수치 묶음 입력(M6/M7) ───────────────────────────────────────
function NumberGroupForm({ question }: { question: NextQuestionDto }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  const spec = numberGroupSpec(question.dimension);

  function update(name: string, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = buildNumberGroupValue(question.dimension, fields);
    if (value === null) {
      setStatus("error");
      setMessage("최소 한 개 항목을 입력해 주세요.");
      return;
    }
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({
        field: question.dimension,
        value,
        confidence: SELF_DECLARED_CONFIDENCE,
      });
      setStatus("idle");
      setMessage(impactMessage(result.impact, result.initialMatch, result.refresh));
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  async function submitUnknown() {
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({ field: question.dimension, unknown: true });
      setStatus("idle");
      setMessage(`모름으로 기록했습니다. 같은 질문은 30일 동안 다시 묻지 않을게요. ${impactMessage(result.impact, result.initialMatch, result.refresh)}`);
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        {spec.map((item) =>
          item.type === "boolean" ? (
            <Field key={item.name}>
              <FieldLabel>{item.label}</FieldLabel>
              <ToggleGroup
                aria-label={item.label}
                className="w-fit"
                value={[fields[item.name] ?? ""]}
                onValueChange={(next) => {
                  const [selected] = next;
                  if (selected) update(item.name, selected);
                }}
                variant="outline"
                spacing={1}
              >
                <ToggleGroupItem value="true">예</ToggleGroupItem>
                <ToggleGroupItem value="false">아니오</ToggleGroupItem>
              </ToggleGroup>
              {item.hint ? <FieldDescription>{item.hint}</FieldDescription> : null}
            </Field>
          ) : (
            <Field key={item.name}>
              <FieldLabel htmlFor={`ng-${item.name}`}>{item.label}</FieldLabel>
              <Input
                id={`ng-${item.name}`}
                inputMode={item.allowNegative ? "text" : "numeric"}
                type="number"
                min={item.allowNegative ? undefined : 0}
                step={item.step}
                placeholder={item.placeholder}
                value={fields[item.name] ?? ""}
                disabled={status === "saving"}
                onChange={(event) => update(item.name, event.currentTarget.value)}
              />
              {item.hint ? <FieldDescription>{item.hint}</FieldDescription> : null}
            </Field>
          ),
        )}
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={status === "saving"}>
          {status === "saving" ? <Spinner data-icon="inline-start" /> : null}
          {status === "saving" ? "저장 중" : "저장"}
        </Button>
        <Button type="button" variant="ghost" disabled={status === "saving"} onClick={() => void submitUnknown()}>
          모름
        </Button>
      </div>
      <p
        className={status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}

// ── 기존 스칼라(number/select/boolean/text) ─────────────────────────────────────
function ScalarQuestionForm({ question }: { question: NextQuestionDto }) {
  const router = useRouter();
  const [value, setValue] = useState(defaultQuestionValue(question));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage("");
    try {
      const range = selectedQuestionRange(question, value);
      const result = range
        ? await saveProfileField({
            field: question.dimension,
            range: { min: range.min, max: range.max, unit: range.unit },
          })
        : await saveProfileField({
            field: question.dimension,
            value: parseQuestionValue(question, value),
            confidence: SELF_DECLARED_CONFIDENCE,
            ...(shouldMergeQuestionValue(question, value) ? { mode: "merge" as const } : {}),
          });
      setStatus("saved");
      setMessage(impactMessage(result.impact, result.initialMatch, result.refresh));
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  async function submitUnknown() {
    setStatus("saving");
    setMessage("");
    try {
      const result = await saveProfileField({ field: question.dimension, unknown: true });
      setStatus("saved");
      setMessage(`모름으로 기록했습니다. 같은 질문은 30일 동안 다시 묻지 않을게요. ${impactMessage(result.impact, result.initialMatch, result.refresh)}`);
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  return (
    <form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start" onSubmit={handleSubmit}>
      <div className="min-w-0">
        <QuestionInput question={question} value={value} onChange={setValue} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={status === "saving" || value.trim().length === 0}>
          {status === "saving" ? <Spinner data-icon="inline-start" /> : null}
          {status === "saving" ? "저장 중" : "저장"}
        </Button>
        <Button type="button" variant="ghost" disabled={status === "saving"} onClick={() => void submitUnknown()}>
          모름
        </Button>
      </div>
      <p className={status === "error" ? "text-sm text-destructive lg:col-span-2" : "text-sm text-muted-foreground lg:col-span-2"} aria-live="polite">
        {message}
      </p>
    </form>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: NextQuestionDto;
  value: string;
  onChange: (value: string) => void;
}) {
  if (question.inputType === "select" && question.options?.length) {
    const items = question.responseStage === "range" && question.rangeOptions?.length
      ? question.rangeOptions.map((option) => ({ label: option.label, value: option.value }))
      : question.options.map((option) => ({ label: option, value: option }));
    return (
      <Select
        aria-label={question.prompt}
        items={items}
        value={value}
        onValueChange={(nextValue) => {
          if (typeof nextValue === "string") onChange(nextValue);
        }}
      >
        <SelectTrigger className="w-full min-w-40">
          <SelectValue placeholder="선택해 주세요" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  }

  if (question.inputType === "boolean") {
    return (
      <ToggleGroup
        aria-label={question.prompt}
        className="w-fit"
        value={[value]}
        onValueChange={(nextValue) => {
          const [selected] = nextValue;
          if (selected) onChange(selected);
        }}
        variant="outline"
        spacing={1}
      >
        <ToggleGroupItem value="true" aria-label="예">
          예
        </ToggleGroupItem>
        <ToggleGroupItem value="false" aria-label="아니오">
          아니오
        </ToggleGroupItem>
      </ToggleGroup>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Input
        aria-label={question.prompt}
        inputMode={question.inputType === "number" ? "numeric" : "text"}
        min={question.inputType === "number" ? 0 : undefined}
        type={question.inputType === "number" ? "number" : "text"}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {question.responseStage === "precise" ? (
        <p className="text-xs text-muted-foreground">
          {question.unit === "krw" ? "원 단위" : question.unit === "people" ? "명 단위" : "정확한 값"}으로 입력해 주세요.
        </p>
      ) : null}
    </div>
  );
}

function impactMessage(
  impact: ProfileUpdateImpact,
  initialMatch: CompanyInitialMatchResult,
  refresh: ProfileQuestionRefreshDto,
): string {
  const currentSummary = `현재 추천 ${initialMatch.counts.recommendable ?? 0}건, 확인 필요 ${initialMatch.counts.reviewNeeded ?? 0}건입니다.`;
  const refreshSummary = refresh.status === "partial"
    ? ` 매칭 상태 ${refresh.savedCount}건을 갱신했고 ${refresh.failedCount}건은 다음 조회에서 다시 반영합니다.`
    : refresh.status === "failed"
      ? ` 매칭 상태 ${refresh.failedCount}건은 다음 조회에서 다시 반영합니다.`
      : refresh.savedCount > 0
        ? ` 매칭 상태 ${refresh.savedCount}건을 갱신했습니다.`
        : "";
  if (impact.targetedConditionalCount === 0) {
    return `저장됨. 현재 공고에서는 이 항목으로 대기 중인 판정이 없어요.${refreshSummary} ${currentSummary}`;
  }
  if (impact.eligibilityResolvedCount === 0) {
    return `저장됨. ${impact.dimensionResolvedGrantCount}건의 조건을 확인했지만 다른 확인 항목이 남아 있어요.${refreshSummary} ${currentSummary}`;
  }
  const details = [
    impact.conditionalToEligibleCount > 0 ? `지원 가능성 높음 ${impact.conditionalToEligibleCount}건` : null,
    impact.conditionalToIneligibleCount > 0 ? `현재 지원 어려움 ${impact.conditionalToIneligibleCount}건` : null,
  ].filter((value): value is string => Boolean(value));
  const remaining = impact.remainingConditionalCount > 0
    ? `, 추가 확인 ${impact.remainingConditionalCount}건`
    : "";
  return `저장됨. ${details.join(", ")}으로 판정됐어요${remaining}.${refreshSummary} ${currentSummary}`;
}

// ── 결격 문항 헬퍼 ──────────────────────────────────────────────────────────────
function isDisqualificationFlag(value: string): value is DisqualificationFlag {
  return value in DISQUALIFICATION_FLAG_LABELS;
}

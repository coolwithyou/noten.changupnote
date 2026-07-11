"use client";

import type { ActionResult, CompanyProfile, CriterionDimension, NextQuestionDto } from "@cunote/contracts";
import {
  DISQUALIFICATION_FLAG_LABELS,
  DISQUALIFICATION_QUESTIONS,
  type DisqualificationFlag,
  type DisqualificationQuestionId,
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
import { regionCodeForLabel } from "@/lib/regions";

interface ProfileFieldResult {
  profile: CompanyProfile;
}

/** 자가신고 기준 confidence — 공용(0.6). */
const SELF_DECLARED_CONFIDENCE = 0.6;

async function saveProfileField(body: {
  field: CriterionDimension;
  value: unknown;
  confidence: number;
}): Promise<void> {
  const response = await fetch("/api/web/profile/field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as ActionResult<ProfileFieldResult>;
  if (!response.ok || !result.ok) {
    throw new Error(result.error?.message ?? "저장하지 못했습니다.");
  }
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
        {question.inputType === "checklist" ? (
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
      await saveProfileField({
        field: question.dimension,
        value: { answers: buildAnswers(question.dimension, flags, heldFlags) },
        confidence: SELF_DECLARED_CONFIDENCE,
      });
      setStatus("idle");
      setMessage("저장됨, 결과를 갱신했습니다.");
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
      await saveProfileField({
        field: question.dimension,
        value,
        confidence: SELF_DECLARED_CONFIDENCE,
      });
      setStatus("idle");
      setMessage("저장됨, 결과를 갱신했습니다.");
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
                inputMode="numeric"
                type="number"
                min={0}
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
      <div>
        <Button type="submit" disabled={status === "saving"}>
          {status === "saving" ? <Spinner data-icon="inline-start" /> : null}
          {status === "saving" ? "저장 중" : "저장"}
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
  const [value, setValue] = useState(defaultValue(question));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage("");
    try {
      await saveProfileField({
        field: question.dimension,
        value: parseValue(question, value),
        confidence: 0.8,
      });
      setStatus("saved");
      setMessage("저장됨, 결과를 갱신했습니다.");
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
      <Button type="submit" disabled={status === "saving" || value.trim().length === 0}>
        {status === "saving" ? <Spinner data-icon="inline-start" /> : null}
        {status === "saving" ? "저장 중" : "저장"}
      </Button>
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
    const items = question.options.map((option) => ({ label: option, value: option }));
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
          <SelectValue />
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
    <Input
      aria-label={question.prompt}
      inputMode={question.inputType === "number" ? "numeric" : "text"}
      min={question.inputType === "number" ? 0 : undefined}
      type={question.inputType === "number" ? "number" : "text"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function defaultValue(question: NextQuestionDto): string {
  if (question.inputType === "select") return question.options?.[0] ?? "";
  if (question.inputType === "boolean") return "true";
  return "";
}

function parseValue(question: NextQuestionDto, value: string): unknown {
  if (question.inputType === "number") return Number(value);
  if (question.inputType === "boolean") return value === "true";
  if (question.dimension === "region") {
    return {
      code: regionCodeForLabel(value) ?? value,
      label: value,
    };
  }
  if (question.dimension === "prior_award" && value === "해당 없음") {
    return [];
  }
  if (isListDimension(question.dimension)) {
    return [value];
  }
  return value;
}

function isListDimension(dimension: NextQuestionDto["dimension"]): boolean {
  return (
    dimension === "industry" ||
    dimension === "founder_trait" ||
    dimension === "certification" ||
    dimension === "prior_award" ||
    dimension === "ip" ||
    dimension === "target_type"
  );
}

// ── 결격 문항 헬퍼 ──────────────────────────────────────────────────────────────
function isDisqualificationFlag(value: string): value is DisqualificationFlag {
  return value in DISQUALIFICATION_FLAG_LABELS;
}

/**
 * 축 내 표시된 플래그 전체를 문항→플래그 매핑으로 answers 형태로 묶는다.
 * 표시된 각 문항은 응답 완료(covers 전체 known)로 처리되고, held는 사용자가 보유로 체크한 플래그.
 */
function buildAnswers(
  dimension: CriterionDimension,
  flags: DisqualificationFlag[],
  held: DisqualificationFlag[],
): Record<DisqualificationQuestionId, { held: DisqualificationFlag[] }> {
  const shown = new Set(flags);
  const heldSet = new Set(held);
  const answers = {} as Record<DisqualificationQuestionId, { held: DisqualificationFlag[] }>;
  for (const q of DISQUALIFICATION_QUESTIONS) {
    if (q.axis !== dimension) continue;
    // 화면에 뜬 플래그를 하나라도 포함하는 문항만 응답 완료로 본다.
    const covered = q.covers.filter((flag) => shown.has(flag));
    if (covered.length === 0) continue;
    answers[q.id] = { held: covered.filter((flag) => heldSet.has(flag)) };
  }
  return answers;
}

// ── 수치 묶음 스펙 ──────────────────────────────────────────────────────────────
type NumberGroupItem =
  | { name: string; type: "number"; label: string; placeholder?: string; hint?: string }
  | { name: string; type: "boolean"; label: string; hint?: string };

function numberGroupSpec(dimension: CriterionDimension): NumberGroupItem[] {
  if (dimension === "financial_health") {
    return [
      { name: "capital_impaired", type: "boolean", label: "자본잠식 상태인가요?", hint: "자본총계가 자본금보다 작으면 예" },
      { name: "debt_ratio_pct", type: "number", label: "부채비율(%) (선택)", placeholder: "예: 250" },
    ];
  }
  if (dimension === "insured_workforce") {
    return [
      { name: "employment_insurance_active", type: "boolean", label: "고용보험 가입 사업장인가요?" },
      { name: "insured_count", type: "number", label: "고용보험 피보험자 수 (선택)", placeholder: "예: 12" },
    ];
  }
  // investment
  return [
    { name: "total_raised_krw", type: "number", label: "누적 투자 유치 금액(원) (선택)", placeholder: "예: 500000000" },
    { name: "tips_backed", type: "boolean", label: "TIPS 선정 이력이 있나요? (선택)" },
  ];
}

function buildNumberGroupValue(
  dimension: CriterionDimension,
  fields: Record<string, string>,
): Record<string, unknown> | null {
  const value: Record<string, unknown> = {};
  let touched = false;
  for (const item of numberGroupSpec(dimension)) {
    const raw = fields[item.name];
    if (raw === undefined || raw === "") continue;
    if (item.type === "boolean") {
      value[item.name] = raw === "true";
      touched = true;
    } else {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        value[item.name] = Math.floor(parsed);
        touched = true;
      }
    }
  }
  return touched ? value : null;
}

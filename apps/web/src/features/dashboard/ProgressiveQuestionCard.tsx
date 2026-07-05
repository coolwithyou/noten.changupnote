"use client";

import type { ActionResult, CompanyProfile, NextQuestionDto } from "@cunote/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export function ProgressiveQuestionCard({ question }: { question: NextQuestionDto }) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue(question));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage("");

    try {
      const response = await fetch("/api/web/profile/field", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          field: question.dimension,
          value: parseValue(question, value),
          confidence: 0.8,
        }),
      });
      const result = await response.json() as ActionResult<ProfileFieldResult>;
      if (!response.ok || !result.ok) {
        throw new Error(result.error?.message ?? "저장하지 못했습니다.");
      }
      setStatus("saved");
      setMessage("저장됨, 결과를 갱신했습니다.");
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  return (
    <Card id="next-question">
      <CardHeader>
        <CardTitle>{question.prompt}</CardTitle>
        <CardDescription>{question.framing}</CardDescription>
        <CardAction>
          <StatusBadge tone="warning">{question.affectedGrantCount}건 영향</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
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

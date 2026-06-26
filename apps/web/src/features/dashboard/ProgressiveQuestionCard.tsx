"use client";

import type { ActionResult, CompanyProfile, NextQuestionDto } from "@cunote/contracts";
import { useState, type FormEvent } from "react";

interface ProfileFieldResult {
  profile: CompanyProfile;
}

export function ProgressiveQuestionCard({ question }: { question: NextQuestionDto }) {
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
      setMessage("저장됨");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    }
  }

  return (
    <section className="next-question-banner">
      <div className="next-question-content">
        <span className="eyebrow">다음 질문</span>
        <h2>{question.prompt}</h2>
        <p>{question.framing}</p>
      </div>
      <form className="next-question-form" onSubmit={handleSubmit}>
        <strong className="next-question-impact">{question.affectedGrantCount}건 영향</strong>
        <div className="next-question-control-row">
          <QuestionInput question={question} value={value} onChange={setValue} />
          <button type="submit" disabled={status === "saving" || value.trim().length === 0}>
            {status === "saving" ? "저장 중" : "저장"}
          </button>
        </div>
        <p className={`question-status ${status === "error" ? "error" : ""}`} aria-live="polite">
          {message}
        </p>
      </form>
    </section>
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
    return (
      <select
        aria-label={question.prompt}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {question.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }

  if (question.inputType === "boolean") {
    return (
      <select
        aria-label={question.prompt}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="true">예</option>
        <option value="false">아니오</option>
      </select>
    );
  }

  return (
    <input
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
  return value;
}

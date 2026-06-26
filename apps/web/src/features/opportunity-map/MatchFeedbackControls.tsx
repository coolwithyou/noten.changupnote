"use client";

import type { ActionResult, FeedbackKind, FeedbackResult, MatchFeedbackRequest } from "@cunote/contracts";
import { useState } from "react";

const FEEDBACK_ACTIONS: Array<{
  kind: FeedbackKind;
  label: string;
  doneLabel: string;
}> = [
  { kind: "saved", label: "저장", doneLabel: "저장됨" },
  { kind: "dismissed", label: "제외", doneLabel: "제외됨" },
  { kind: "wrong", label: "오류", doneLabel: "오류 접수" },
  { kind: "applied", label: "신청함", doneLabel: "신청 기록됨" },
];

export function MatchFeedbackControls({ grantId, title }: { grantId: string; title: string }) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [activeKind, setActiveKind] = useState<FeedbackKind | null>(null);
  const [message, setMessage] = useState("");

  async function submitFeedback(kind: FeedbackKind) {
    setStatus("saving");
    setActiveKind(kind);
    setMessage("");

    const body: MatchFeedbackRequest = { kind };
    try {
      const response = await fetch(`/api/web/matches/${encodeURIComponent(grantId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as ActionResult<FeedbackResult>;
      if (!response.ok || !result.ok) {
        throw new Error(result.error?.message ?? "피드백을 저장하지 못했습니다.");
      }

      const action = FEEDBACK_ACTIONS.find((item) => item.kind === kind);
      setStatus("saved");
      setMessage(action?.doneLabel ?? "저장됨");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "피드백을 저장하지 못했습니다.");
    }
  }

  return (
    <div className="match-feedback" aria-label={`${title} 피드백`}>
      <div className="match-feedback-controls">
        {FEEDBACK_ACTIONS.map((action) => (
          <button
            key={action.kind}
            type="button"
            className={activeKind === action.kind && status === "saved" ? "selected" : ""}
            disabled={status === "saving"}
            onClick={() => submitFeedback(action.kind)}
            aria-label={`${title} ${action.label}`}
          >
            {status === "saving" && activeKind === action.kind ? "저장 중" : action.label}
          </button>
        ))}
      </div>
      <p className={`feedback-status ${status === "error" ? "error" : ""}`} aria-live="polite">
        {message}
      </p>
    </div>
  );
}

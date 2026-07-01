"use client";

import type { ActionResult, FeedbackResult, MatchFeedbackRequest } from "@cunote/contracts";
import { Bookmark, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { GrantArchiveApplicationStage } from "@/lib/server/archive/grantArchiveSearch";

export function ArchiveSaveButton({
  grantId,
  initialStage,
}: {
  grantId: string;
  initialStage: GrantArchiveApplicationStage | null;
}) {
  const initiallySaved = initialStage !== null && initialStage !== "dismissed";
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(initiallySaved ? "saved" : "idle");
  const [message, setMessage] = useState("");

  async function saveGrant() {
    setStatus("saving");
    setMessage("");
    const body: MatchFeedbackRequest = { kind: "saved" };
    try {
      const response = await fetch(`/api/web/matches/${encodeURIComponent(grantId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as ActionResult<FeedbackResult>;
      if (!response.ok || !result.ok) {
        throw new Error(result.error?.message ?? "공고를 저장하지 못했습니다.");
      }
      setStatus("saved");
      setMessage("저장됨");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "공고를 저장하지 못했습니다.");
    }
  }

  return (
    <span className="archive-save-action">
      <Button
        type="button"
        size="sm"
        variant={status === "saved" ? "secondary" : "outline"}
        disabled={status === "saving" || status === "saved"}
        onClick={saveGrant}
      >
        {status === "saving" ? <Spinner data-icon="inline-start" /> : status === "saved" ? <Check data-icon="inline-start" /> : <Bookmark data-icon="inline-start" />}
        {status === "saving" ? "저장 중" : status === "saved" ? "저장됨" : "저장"}
      </Button>
      <span className={status === "error" ? "archive-save-message error" : "archive-save-message"} aria-live="polite">
        {message}
      </span>
    </span>
  );
}

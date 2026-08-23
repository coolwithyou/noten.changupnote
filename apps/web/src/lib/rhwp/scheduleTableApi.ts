import type { ActionResult } from "@cunote/contracts";
import type { ScheduleSuggestionRequest, ScheduleTablePlan } from "./scheduleTableContract";

export interface ScheduleSuggestionResponse {
  plan: ScheduleTablePlan;
  modelVersion: string;
  groundingBindingSha256: string;
}

export async function requestScheduleSuggestion(
  draftId: string,
  input: ScheduleSuggestionRequest,
): Promise<ScheduleSuggestionResponse> {
  const response = await fetch(
    `/api/web/document-drafts/${encodeURIComponent(draftId)}/schedule-suggestions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const payload = (await response.json()) as ActionResult<ScheduleSuggestionResponse>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(payload.error?.message ?? "사업추진 일정안을 만들지 못했습니다.");
  }
  return payload.data;
}

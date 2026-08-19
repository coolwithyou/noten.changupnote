import type { ActionResult } from "@cunote/contracts";
import type { StudioFieldTargetV1 } from "./studioDocumentAgentProtocol";
import type {
  FieldAgentRunDto,
  FieldAgentSuggestionAction,
  FieldAgentSuggestionDto,
} from "@/lib/server/documents/fieldAgentRuns";

export function fetchFieldAgentRuns(draftId: string): Promise<FieldAgentRunDto[]> {
  return requestJson(`/api/web/document-drafts/${encodeURIComponent(draftId)}/field-agent-suggestions`, {
    method: "GET",
  });
}

export function requestFieldAgentRun(input: {
  draftId: string;
  fieldId: string;
  clientRequestId: string;
  baseRevisionId: string;
  target: StudioFieldTargetV1;
  sourceText?: string;
}): Promise<FieldAgentRunDto> {
  const { draftId, ...body } = input;
  return requestJson(`/api/web/document-drafts/${encodeURIComponent(draftId)}/field-agent-suggestions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function transitionFieldAgentRunSuggestion(input: {
  draftId: string;
  suggestionId: string;
  action: FieldAgentSuggestionAction;
  expectedStatusVersion: number;
  expectedOperationVersion: number;
  operationClientId?: string;
  failureCode?: string;
}): Promise<FieldAgentSuggestionDto> {
  const { draftId, suggestionId, ...body } = input;
  return requestJson(
    `/api/web/document-drafts/${encodeURIComponent(draftId)}/field-agent-suggestions/${encodeURIComponent(suggestionId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json()) as ActionResult<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new FieldAgentApiError(
      payload.error?.code ?? "field_agent_request_failed",
      payload.error?.message ?? "AI 필드 요청을 처리하지 못했습니다.",
      response.status,
      payload.error?.meta ?? null,
    );
  }
  return payload.data;
}

export class FieldAgentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly meta: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "FieldAgentApiError";
  }
}

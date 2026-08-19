import type { ActionResult } from "@cunote/contracts";
import type { DocumentEditAnchor } from "./documentAgentContract";
import type {
  DocumentAgentRunDto,
  DocumentAgentSuggestionAction,
  DocumentAgentSuggestionDto,
  RequestDocumentAgentSuggestionsResult,
} from "@/lib/server/documents/documentAgentRuns";

export async function fetchDocumentAgentRuns(draftId: string): Promise<DocumentAgentRunDto[]> {
  return requestJson<DocumentAgentRunDto[]>(
    `/api/web/document-drafts/${encodeURIComponent(draftId)}/agent-suggestions`,
    { method: "GET" },
  );
}

export async function requestDocumentAgentSuggestions(input: {
  draftId: string;
  clientRequestId: string;
  checkpointRequestId: string;
  baseRevisionId: string;
  selectedPage: number;
  candidateId: string;
  anchor: DocumentEditAnchor;
}): Promise<RequestDocumentAgentSuggestionsResult> {
  return requestJson<RequestDocumentAgentSuggestionsResult>(
    `/api/web/document-drafts/${encodeURIComponent(input.draftId)}/agent-suggestions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientRequestId: input.clientRequestId,
        checkpointRequestId: input.checkpointRequestId,
        baseRevisionId: input.baseRevisionId,
        selectedPage: input.selectedPage,
        candidateHint: { candidateId: input.candidateId, anchor: input.anchor },
      }),
    },
  );
}

export async function transitionDocumentAgentSuggestion(input: {
  draftId: string;
  suggestionId: string;
  action: DocumentAgentSuggestionAction;
  expectedStatusVersion: number;
  expectedOperationVersion: number;
  operationClientId?: string;
  documentSha256?: string;
  failureCode?: string;
}): Promise<DocumentAgentSuggestionDto> {
  const { draftId, suggestionId, ...body } = input;
  return requestJson<DocumentAgentSuggestionDto>(
    `/api/web/document-drafts/${encodeURIComponent(draftId)}/agent-suggestions/${encodeURIComponent(suggestionId)}`,
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
    throw new DocumentAgentApiError(
      payload.error?.code ?? "document_agent_request_failed",
      payload.error?.message ?? "문서 AI 요청을 처리하지 못했습니다.",
      response.status,
      payload.error?.meta ?? null,
    );
  }
  return payload.data;
}

export class DocumentAgentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly meta: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "DocumentAgentApiError";
  }
}

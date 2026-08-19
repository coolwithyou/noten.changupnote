import type { DocumentEditCandidate } from "@/lib/rhwp/documentAgentContract";
import type { DocumentAgentRunDto } from "@/lib/server/documents/documentAgentRuns";

export type DocumentAgentUiPhase =
  | "closed"
  | "idle"
  | "scanning"
  | "target_selected"
  | "checkpointing"
  | "generating"
  | "reviewing"
  | "applying"
  | "undoing"
  | "error";

export interface DocumentAgentUiState {
  phase: DocumentAgentUiPhase;
  selectedPage: number;
  candidates: DocumentEditCandidate[];
  selectedCandidateId: string | null;
  checkpointRequestId: string | null;
  clientRequestId: string | null;
  run: DocumentAgentRunDto | null;
  error: string | null;
}

export const initialDocumentAgentUiState: DocumentAgentUiState = {
  phase: "closed",
  selectedPage: 1,
  candidates: [],
  selectedCandidateId: null,
  checkpointRequestId: null,
  clientRequestId: null,
  run: null,
  error: null,
};

export type DocumentAgentUiAction =
  | { type: "open"; pageCount: number }
  | { type: "close" }
  | { type: "history_loaded"; run: DocumentAgentRunDto }
  | { type: "select_page"; page: number; pageCount: number }
  | { type: "scan_started" }
  | { type: "scan_succeeded"; candidates: DocumentEditCandidate[] }
  | { type: "select_candidate"; candidateId: string }
  | { type: "request_started"; checkpointRequestId: string; clientRequestId: string }
  | { type: "checkpoint_saved" }
  | { type: "run_received"; run: DocumentAgentRunDto }
  | { type: "operation_started"; operation: "apply" | "undo" }
  | { type: "operation_finished"; run: DocumentAgentRunDto }
  | { type: "failed"; message: string }
  | { type: "retry" };

export function reduceDocumentAgentUiState(
  state: DocumentAgentUiState,
  action: DocumentAgentUiAction,
): DocumentAgentUiState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        phase: "idle",
        selectedPage: clampPage(state.selectedPage, action.pageCount),
        error: null,
      };
    case "close":
      if (state.phase === "checkpointing" || state.phase === "generating" || state.phase === "applying" || state.phase === "undoing") {
        throw new Error("진행 중인 document agent 작업은 Sheet 닫기로 중단할 수 없습니다.");
      }
      return { ...state, phase: "closed", error: null };
    case "history_loaded":
      if (state.phase === "closed") return state;
      assertPhase(state, ["idle"]);
      return {
        ...state,
        phase: "reviewing",
        selectedPage: action.run.selectedPage,
        candidates: [action.run.candidate],
        selectedCandidateId: action.run.candidateId,
        run: action.run,
        error: null,
      };
    case "select_page":
      assertPhase(state, ["idle", "target_selected", "reviewing", "error"]);
      return {
        ...state,
        phase: "idle",
        selectedPage: clampPage(action.page, action.pageCount),
        candidates: [],
        selectedCandidateId: null,
        checkpointRequestId: null,
        clientRequestId: null,
        run: null,
        error: null,
      };
    case "scan_started":
      assertPhase(state, ["idle", "target_selected", "reviewing", "error"]);
      return {
        ...state,
        phase: "scanning",
        candidates: [],
        selectedCandidateId: null,
        checkpointRequestId: null,
        clientRequestId: null,
        run: null,
        error: null,
      };
    case "scan_succeeded":
      assertPhase(state, ["scanning"]);
      return {
        ...state,
        phase: action.candidates.length > 0 ? "target_selected" : "idle",
        candidates: action.candidates,
        selectedCandidateId: action.candidates[0]?.candidateId ?? null,
        error: null,
      };
    case "select_candidate":
      assertPhase(state, ["target_selected"]);
      if (!state.candidates.some((candidate) => candidate.candidateId === action.candidateId)) {
        throw new Error("현재 후보 목록에 없는 document agent target입니다.");
      }
      return { ...state, selectedCandidateId: action.candidateId };
    case "request_started":
      assertPhase(state, ["target_selected"]);
      if (!state.selectedCandidateId) throw new Error("선택한 document agent target이 없습니다.");
      return {
        ...state,
        phase: "checkpointing",
        checkpointRequestId: action.checkpointRequestId,
        clientRequestId: action.clientRequestId,
        error: null,
      };
    case "checkpoint_saved":
      assertPhase(state, ["checkpointing"]);
      return { ...state, phase: "generating" };
    case "run_received":
      if (state.phase === "closed") return state;
      assertPhase(state, ["generating", "reviewing", "error"]);
      return { ...state, phase: "reviewing", run: action.run, error: null };
    case "operation_started":
      assertPhase(state, ["reviewing"]);
      return { ...state, phase: action.operation === "apply" ? "applying" : "undoing", error: null };
    case "operation_finished":
      assertPhase(state, ["applying", "undoing"]);
      return { ...state, phase: "reviewing", run: action.run, error: null };
    case "failed":
      if (state.phase === "closed") throw new Error("닫힌 document agent Sheet에 오류를 기록할 수 없습니다.");
      return { ...state, phase: "error", error: action.message };
    case "retry":
      assertPhase(state, ["error"]);
      return state.run
        ? { ...state, phase: "reviewing", error: null }
        : state.candidates.length > 0
          ? { ...state, phase: "target_selected", error: null }
          : { ...state, phase: "idle", error: null };
  }
}

function assertPhase(state: DocumentAgentUiState, allowed: DocumentAgentUiPhase[]): void {
  if (!allowed.includes(state.phase)) {
    throw new Error(`document agent UI illegal transition: ${state.phase}`);
  }
}

function clampPage(page: number, pageCount: number): number {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return 1;
  return Math.min(pageCount, Math.max(1, Number.isSafeInteger(page) ? page : 1));
}

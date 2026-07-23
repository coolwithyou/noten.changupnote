export type StudioSavePhase = "exporting" | "verifying" | "uploading";

export type StudioSaveState =
  | {
      kind: "legacy-manual";
      lastSavedAt: string | null;
      revisionId: string | null;
    }
  | {
      kind: "dirty";
      changeSeq: number;
      lastSavedAt: string | null;
    }
  | {
      kind: "scheduled";
      changeSeq: number;
      dueAt: number;
      lastSavedAt: string | null;
    }
  | {
      kind: "saving";
      changeSeq: number | null;
      phase: StudioSavePhase;
      lastSavedAt: string | null;
    }
  | {
      kind: "clean";
      changeSeq: number;
      savedAt: string;
      revisionId: string;
    }
  | {
      kind: "tab-only";
      savedAt: string;
      message: string;
    }
  | {
      kind: "error";
      changeSeq: number | null;
      lastSavedAt: string | null;
      message: string;
      hasTabSnapshot: boolean;
    };

export type StudioSaveEvent =
  | {
      type: "loaded";
      supportsChangeEvents: boolean;
      revisionId: string | null;
      savedAt: string | null;
      changeSeq?: number;
    }
  | { type: "changed"; changeSeq: number }
  | { type: "scheduled"; changeSeq: number; dueAt: number }
  | { type: "save-started"; changeSeq: number | null; phase?: StudioSavePhase }
  | { type: "save-phase"; phase: StudioSavePhase }
  | { type: "tab-snapshot"; savedAt: string; message?: string }
  | {
      type: "save-succeeded";
      revisionId: string;
      savedAt: string;
      savedSeq: number | null;
      currentSeq: number | null;
      supportsChangeEvents: boolean;
    }
  | {
      type: "save-failed";
      changeSeq: number | null;
      message: string;
      hasTabSnapshot: boolean;
    };

export const initialStudioSaveState: StudioSaveState = {
  kind: "legacy-manual",
  lastSavedAt: null,
  revisionId: null,
};

export function reduceStudioSaveState(
  state: StudioSaveState,
  event: StudioSaveEvent,
): StudioSaveState {
  switch (event.type) {
    case "loaded":
      if (!event.supportsChangeEvents) {
        return {
          kind: "legacy-manual",
          revisionId: event.revisionId,
          lastSavedAt: event.savedAt,
        };
      }
      if (event.revisionId && event.savedAt) {
        return {
          kind: "clean",
          revisionId: event.revisionId,
          savedAt: event.savedAt,
          changeSeq: event.changeSeq ?? 0,
        };
      }
      return {
        kind: "dirty",
        changeSeq: event.changeSeq ?? 0,
        lastSavedAt: null,
      };
    case "changed":
      return {
        kind: "dirty",
        changeSeq: event.changeSeq,
        lastSavedAt: lastSavedAtOf(state),
      };
    case "scheduled":
      return {
        kind: "scheduled",
        changeSeq: event.changeSeq,
        dueAt: event.dueAt,
        lastSavedAt: lastSavedAtOf(state),
      };
    case "save-started":
      return {
        kind: "saving",
        changeSeq: event.changeSeq,
        phase: event.phase ?? "exporting",
        lastSavedAt: lastSavedAtOf(state),
      };
    case "save-phase":
      if (state.kind !== "saving") return state;
      return { ...state, phase: event.phase };
    case "tab-snapshot":
      return {
        kind: "tab-only",
        savedAt: event.savedAt,
        message: event.message ?? "서버 저장을 마치지 못해 현재 브라우저 탭에만 보관했습니다.",
      };
    case "save-succeeded":
      if (
        event.supportsChangeEvents
        && event.savedSeq !== null
        && event.currentSeq !== null
        && event.currentSeq > event.savedSeq
      ) {
        return {
          kind: "dirty",
          changeSeq: event.currentSeq,
          lastSavedAt: event.savedAt,
        };
      }
      if (!event.supportsChangeEvents || event.savedSeq === null) {
        return {
          kind: "legacy-manual",
          revisionId: event.revisionId,
          lastSavedAt: event.savedAt,
        };
      }
      return {
        kind: "clean",
        revisionId: event.revisionId,
        savedAt: event.savedAt,
        changeSeq: event.savedSeq,
      };
    case "save-failed":
      return {
        kind: "error",
        changeSeq: event.changeSeq,
        lastSavedAt: lastSavedAtOf(state),
        message: event.message,
        hasTabSnapshot: event.hasTabSnapshot,
      };
  }
}

export function isStudioSaveInFlight(state: StudioSaveState): boolean {
  return state.kind === "saving";
}

function lastSavedAtOf(state: StudioSaveState): string | null {
  switch (state.kind) {
    case "legacy-manual":
      return state.lastSavedAt;
    case "dirty":
    case "scheduled":
    case "saving":
    case "error":
      return state.lastSavedAt;
    case "clean":
    case "tab-only":
      return state.savedAt;
  }
}

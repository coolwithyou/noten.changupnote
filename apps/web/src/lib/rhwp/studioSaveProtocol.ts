import type { RhwpEditor } from "@rhwp/editor";
import type { HwpVerifyResult } from "@rhwp/editor";
import type { RhwpDocumentFormat } from "./client";

export interface RhwpDocumentChange {
  documentEpoch: number;
  changeSeq: number;
  dirty: boolean;
  reason?: string;
}

export interface RhwpSnapshotResult {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  pageCount: number;
  documentEpoch: number;
  changeSeq: number;
  verification: HwpVerifyResult | null;
}

export interface RhwpStudioSaveProtocol {
  supportsChangeEvents: boolean;
  supportsSnapshotExport: boolean;
  getDirtyState(): Promise<RhwpDocumentChange> | null;
  exportSnapshot(): Promise<RhwpSnapshotResult> | null;
  subscribeDocumentChanged(listener: (change: RhwpDocumentChange) => void): (() => void) | null;
}

type ExperimentalRhwpEditor = RhwpEditor & {
  getDirtyState?: () => Promise<RhwpDocumentChange>;
  exportSnapshot?: () => Promise<RhwpSnapshotResult>;
  subscribe?: (
    event: "documentChanged" | "saveStateChanged",
    listener: (payload: RhwpDocumentChange) => void,
  ) => () => void;
};

/**
 * 향후 자가 호스팅 Studio capability를 구조적으로 감지한다.
 *
 * @rhwp/editor 0.7.19에는 이 메서드가 없으므로 현재는 정확히 legacy 폴백을 반환한다. 패키지와
 * Studio가 새 capability를 배포하면 앱 컴포넌트 변경 없이 event-driven 저장을 활성화할 수 있다.
 */
export function resolveRhwpStudioSaveProtocol(editor: RhwpEditor): RhwpStudioSaveProtocol {
  const experimental = editor as ExperimentalRhwpEditor;
  const supportsChangeEvents =
    typeof experimental.getDirtyState === "function"
    && typeof experimental.subscribe === "function";
  const supportsSnapshotExport = typeof experimental.exportSnapshot === "function";

  return {
    supportsChangeEvents,
    supportsSnapshotExport,
    getDirtyState: () => experimental.getDirtyState?.call(experimental) ?? null,
    exportSnapshot: () => experimental.exportSnapshot?.call(experimental) ?? null,
    subscribeDocumentChanged(listener) {
      if (!supportsChangeEvents || !experimental.subscribe) return null;
      return experimental.subscribe.call(experimental, "documentChanged", listener);
    },
  };
}

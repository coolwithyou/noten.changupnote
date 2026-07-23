import type { ActionResult } from "@cunote/contracts";
import type { RhwpDocumentFormat } from "./client";

export interface PersistStudioSnapshotInput {
  draftId: string;
  bytes: Uint8Array;
  filename: string;
  format: RhwpDocumentFormat;
  pageCount: number;
  sessionId: string;
  baseRevisionId: string | null;
  documentEpoch: number;
  changeSeq: number;
  origin: "studio_autosave" | "studio_manual";
  materializedAnswers: Record<string, string>;
  verification?: Record<string, unknown>;
}

export interface PersistStudioSnapshotResult {
  revisionId: string;
  headRevisionId: string;
  sha256: string;
  savedAt: string;
  byteSize: number;
  pageCount: number;
}

export async function persistStudioSnapshot(
  input: PersistStudioSnapshotInput,
): Promise<PersistStudioSnapshotResult> {
  const form = new FormData();
  const copy = input.bytes.slice();
  form.set(
    "file",
    new File([copy.buffer as ArrayBuffer], input.filename, {
      type: input.format === "hwp" ? "application/x-hwp" : "application/hwp+zip",
    }),
  );
  form.set("format", input.format);
  form.set("pageCount", String(input.pageCount));
  form.set("sessionId", input.sessionId);
  if (input.baseRevisionId) form.set("baseRevisionId", input.baseRevisionId);
  form.set("documentEpoch", String(input.documentEpoch));
  form.set("changeSeq", String(input.changeSeq));
  form.set("origin", input.origin);
  form.set("materializedAnswers", JSON.stringify(input.materializedAnswers));
  form.set("verification", JSON.stringify(input.verification ?? {}));

  const response = await fetch(
    `/api/web/document-drafts/${encodeURIComponent(input.draftId)}/studio-snapshots`,
    {
      method: "POST",
      body: form,
    },
  );
  const payload = (await response.json()) as ActionResult<PersistStudioSnapshotResult>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new StudioSnapshotPersistenceError(
      payload.error?.code ?? "studio_snapshot_save_failed",
      payload.error?.message ?? "Studio 작업본을 서버에 저장하지 못했습니다.",
      response.status,
      typeof payload.error?.meta?.currentRevisionId === "string"
        ? payload.error.meta.currentRevisionId
        : null,
    );
  }
  return payload.data;
}

export class StudioSnapshotPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly currentRevisionId: string | null,
  ) {
    super(message);
    this.name = "StudioSnapshotPersistenceError";
  }
}

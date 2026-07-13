export type OperationalAttachmentAction =
  | "backfill_attachment_metadata"
  | "inspect_unsupported_attachments"
  | "ocr_images"
  | "archive_attachments"
  | "register_attachment_surfaces"
  | "repair_attachment_linkage"
  | "convert_attachments"
  | "reextract"
  | "repair_evidence"
  | "human_review";

export interface OperationalAttachmentState {
  archivedCount: number;
  validArchivedCount: number;
  surfaceCount: number;
  pendingLinkedSurfaceCount: number;
  pendingUnlinkedSurfaceCount: number;
  convertedSurfaceCount: number;
  failedSurfaceCount: number;
}

export function operationalActionFor(
  plannedActions: string | string[],
  attachmentsExpected: number,
  state: OperationalAttachmentState,
  archiveableAttachmentCount?: number,
  unarchivedAttachmentCount?: number,
  ocrableAttachmentCount?: number,
): OperationalAttachmentAction {
  const actions = Array.isArray(plannedActions) ? plannedActions : [plannedActions];
  const attachmentAction = actions.some((action) =>
    action === "archive_attachments" || action === "register_or_convert_attachments");
  if (!attachmentAction) return (actions[0] ?? "human_review") as OperationalAttachmentAction;
  if (attachmentsExpected > state.validArchivedCount) {
    if (archiveableAttachmentCount === 0) {
      if ((ocrableAttachmentCount ?? 0) > 0) return "ocr_images";
      return (unarchivedAttachmentCount ?? 0) > 0
        ? "inspect_unsupported_attachments"
        : "backfill_attachment_metadata";
    }
    return "archive_attachments";
  }
  if (state.surfaceCount === 0) return "register_attachment_surfaces";
  if (state.pendingUnlinkedSurfaceCount > 0) return "repair_attachment_linkage";
  if (state.pendingLinkedSurfaceCount > 0 || state.failedSurfaceCount > 0) return "convert_attachments";
  return (actions.find((action) =>
    action !== "archive_attachments" && action !== "register_or_convert_attachments") ??
    "human_review") as OperationalAttachmentAction;
}

export function emptyAttachmentState(): OperationalAttachmentState {
  return {
    archivedCount: 0,
    validArchivedCount: 0,
    surfaceCount: 0,
    pendingLinkedSurfaceCount: 0,
    pendingUnlinkedSurfaceCount: 0,
    convertedSurfaceCount: 0,
    failedSurfaceCount: 0,
  };
}

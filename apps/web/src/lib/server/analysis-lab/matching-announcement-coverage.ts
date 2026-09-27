import type { LabAttachmentPreparationDiagnostic } from "./input";

export class MatchingAnnouncementInputMissingError extends Error {
  readonly code = "matching_announcement_input_missing" as const;

  constructor(filenames: readonly string[]) {
    super(filenames.length === 0
      ? "Matching announcement input report is unavailable"
      : `Matching announcement input is unavailable: ${filenames.join(", ")}`);
    this.name = "MatchingAnnouncementInputMissingError";
  }
}

/** Explicit announcement attachments must be loaded before a matching-only model call. */
export function assertMatchingAnnouncementCoverage(
  report: readonly LabAttachmentPreparationDiagnostic[] | undefined,
): void {
  if (!report) throw new MatchingAnnouncementInputMissingError([]);
  const missing = report.filter((attachment) =>
    attachment.documentRole === "announcement"
      && attachment.inputOutcome !== "loaded"
      && attachment.inputOutcome !== "covered_by_children");
  if (missing.length > 0) {
    throw new MatchingAnnouncementInputMissingError(missing.map((attachment) => attachment.filename));
  }
}

import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  saveStudioSnapshot,
  type StudioSnapshotSaveResult,
} from "@/lib/server/documents/documentRevisions";
import type { DraftSourceFormat } from "@/lib/server/documents/draftSourceFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const form = await request.formData();
    const file = requireFile(form.get("file"));
    const format = requireFormat(form.get("format"));
    const pageCount = requireNonNegativeInteger(form.get("pageCount"), "pageCount", { minimum: 1 });
    const sessionId = requireText(form.get("sessionId"), "sessionId");
    const baseRevisionId = optionalText(form.get("baseRevisionId"));
    const documentEpoch = requireNonNegativeInteger(form.get("documentEpoch"), "documentEpoch");
    const changeSeq = requireNonNegativeInteger(form.get("changeSeq"), "changeSeq");
    const origin = requireOrigin(form.get("origin"));
    const materializedAnswers = parseStringMap(form.get("materializedAnswers"), "materializedAnswers");
    const verification = parseVerification(form.get("verification"));

    const data = await saveStudioSnapshot({
      draftId,
      access,
      body: Buffer.from(await file.arrayBuffer()),
      format,
      filename: file.name || `창업노트-작업본.${format}`,
      pageCount,
      sessionId,
      baseRevisionId,
      documentEpoch,
      changeSeq,
      origin,
      materializedAnswers,
      verification,
    });
    return NextResponse.json<ActionResult<StudioSnapshotSaveResult>>(
      { ok: true, data },
      { status: 201 },
    );
  } catch (error) {
    return webActionError<StudioSnapshotSaveResult>(error, {
      code: "studio_snapshot_save_failed",
      message: "Studio 작업본을 서버에 저장하지 못했습니다.",
    });
  }
}

function requireFile(value: FormDataEntryValue | null): File {
  if (!(value instanceof File)) {
    throw new SnapshotRequestError("snapshot_file_required", "저장할 Studio 작업본이 필요합니다.", 400);
  }
  return value;
}

function requireFormat(value: FormDataEntryValue | null): DraftSourceFormat {
  if (value !== "hwp" && value !== "hwpx") {
    throw new SnapshotRequestError("snapshot_format_invalid", "문서 형식은 hwp 또는 hwpx여야 합니다.", 400);
  }
  return value;
}

function requireOrigin(value: FormDataEntryValue | null): "studio_autosave" | "studio_manual" {
  if (value !== "studio_autosave" && value !== "studio_manual") {
    throw new SnapshotRequestError(
      "snapshot_origin_invalid",
      "Studio 저장 유형이 올바르지 않습니다.",
      400,
      "origin",
    );
  }
  return value;
}

function requireText(value: FormDataEntryValue | null, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SnapshotRequestError(`snapshot_${field}_required`, `${field} 값이 필요합니다.`, 400, field);
  }
  return value.trim();
}

function optionalText(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireNonNegativeInteger(
  value: FormDataEntryValue | null,
  field: string,
  options: { minimum?: number } = {},
): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  const minimum = options.minimum ?? 0;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new SnapshotRequestError(
      `snapshot_${field}_invalid`,
      `${field} 값이 올바르지 않습니다.`,
      400,
      field,
    );
  }
  return parsed;
}

function parseVerification(value: FormDataEntryValue | null): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("verification must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new SnapshotRequestError(
      "snapshot_verification_invalid",
      "문서 검증 정보를 해석하지 못했습니다.",
      400,
      "verification",
    );
  }
}

function parseStringMap(value: FormDataEntryValue | null, field: string): Record<string, string> {
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${field} must be an object`);
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "string") throw new Error(`${field}.${key} must be a string`);
      result[key] = entry;
    }
    return result;
  } catch {
    throw new SnapshotRequestError(
      `snapshot_${field}_invalid`,
      `${field} 값을 해석하지 못했습니다.`,
      400,
      field,
    );
  }
}

class SnapshotRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SnapshotRequestError";
  }
}

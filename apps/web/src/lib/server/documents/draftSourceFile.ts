import { eq } from "drizzle-orm";
import { detectHwpFormat } from "@cunote/core/documents/hwpx-fill";
import type { DocumentDraft, Grant } from "@cunote/contracts";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { resolveArchiveStorageKey } from "./documentFieldLink";

export type DraftSourceFormat = "hwp" | "hwpx";

export interface DraftSourceFile {
  body: Buffer;
  filename: string;
  format: DraftSourceFormat;
  contentType: "application/x-hwp" | "application/hwp+zip";
  grant: { source: Grant["source"]; sourceId: string };
}

export class DraftSourceFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DraftSourceFileError";
  }
}

/**
 * 소유권이 이미 검증된 draft에서 원본 HWP/HWPX를 가져오는 단일 서버 경계.
 * 클라이언트가 storage key를 고를 수 없도록 draft의 grantId+sourceAttachment만 사용한다.
 */
export async function loadDraftSourceFile(input: {
  draft: Pick<DocumentDraft, "grantId" | "sourceAttachment">;
}): Promise<DraftSourceFile> {
  const filename = input.draft.sourceAttachment?.trim();
  if (!filename) {
    throw new DraftSourceFileError(
      "document_source_missing",
      "이 서류에는 원본 HWP/HWPX 양식이 연결돼 있지 않습니다.",
      409,
    );
  }

  const db = getCunoteDb();
  const [grant] = await db
    .select({ source: schema.grants.source, sourceId: schema.grants.sourceId })
    .from(schema.grants)
    .where(eq(schema.grants.id, input.draft.grantId))
    .limit(1);
  if (!grant) {
    throw new DraftSourceFileError("grant_not_found", "공고 정보를 찾지 못했습니다.", 404);
  }

  const archive = await resolveArchiveStorageKey({
    source: grant.source,
    sourceId: grant.sourceId,
    filename,
  });
  if (!archive?.storageKey) {
    throw new DraftSourceFileError(
      "document_source_not_found",
      "원본 HWP/HWPX 양식 보관본을 찾지 못했습니다.",
      404,
    );
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new DraftSourceFileError(
      "storage_not_configured",
      "파일 저장소(R2)가 설정되지 않아 원본 양식을 불러오지 못했습니다.",
      503,
    );
  }

  let body: Buffer;
  try {
    body = (await storage.getObjectBytes(archive.storageKey)).body;
  } catch (error) {
    throw new DraftSourceFileError(
      "document_source_fetch_failed",
      `원본 양식 보관본을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  const detected = detectHwpFormat(body);
  if (detected === "unknown") {
    throw new DraftSourceFileError(
      "document_source_unsupported",
      "원본 파일이 지원되는 HWP/HWPX 형식이 아니거나 손상되었습니다.",
      415,
    );
  }
  const format: DraftSourceFormat = detected === "hwp-binary" ? "hwp" : "hwpx";
  return {
    body,
    filename,
    format,
    contentType: format === "hwp" ? "application/x-hwp" : "application/hwp+zip",
    grant,
  };
}

import { createHash } from "node:crypto";
import { extname } from "node:path";

import { NextResponse } from "next/server";

import { contentTypeForExt, safeName } from "@/lib/server/knowledge/extraction";
import { serializeKnowledgeSource } from "@/lib/server/knowledge/knowledgeDashboardData";
import {
  KNOWLEDGE_SOURCE_KINDS,
  findSourceBySha256,
  insertKnowledgeSource,
  type KnowledgeSourceKind,
} from "@/lib/server/knowledge/knowledgeRepo";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EXT = new Set([".pdf", ".txt", ".md"]);
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * 운영 지식 원천 문서 등록(GUI 업로드).
 *
 * multipart form: file(필수) + kind/title/program/institution/sourceDate(선택).
 * - 확장자 .pdf/.txt/.md, 크기 상한 20MB.
 * - sha256 dedupe: 이미 등록된 파일이면 200 + { alreadyRegistered: true, source }(멱등 — 에러 아님).
 * - R2 업로드(knowledge-sources/<sha12>/<safeName>) 후 status='registered' 로 insert.
 * 추출은 별도(POST .../[sourceId]/extract). 등록만으로는 lesson 이 생기지 않는다.
 */
export async function POST(request: Request) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!isUploadFile(file)) {
    return NextResponse.json(
      { ok: false, error: "file_required", message: "업로드할 파일을 선택하세요." },
      { status: 400 },
    );
  }

  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { ok: false, error: "unsupported_ext", message: ".pdf / .txt / .md 만 지원합니다." },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", message: "파일 크기는 20MB 이하여야 합니다." },
      { status: 400 },
    );
  }

  const kind = (readField(form, "kind") || "ops_interview") as KnowledgeSourceKind;
  if (!(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { ok: false, error: "invalid_kind", message: `kind 는 ${KNOWLEDGE_SOURCE_KINDS.join(" | ")} 중 하나여야 합니다.` },
      { status: 400 },
    );
  }

  const title = readField(form, "title") || file.name;
  const program = readField(form, "program") || null;
  const institution = readField(form, "institution") || null;
  const sourceDate = readField(form, "sourceDate") || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
    return NextResponse.json(
      { ok: false, error: "invalid_source_date", message: "sourceDate 는 YYYY-MM-DD 여야 합니다." },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha12 = sha256.slice(0, 12);

  // 멱등: 같은 sha256 이 이미 등록됐으면 200 으로 기존 원천을 돌려준다(에러 아님).
  const existing = await findSourceBySha256(sha256);
  if (existing) {
    return NextResponse.json({ ok: true, alreadyRegistered: true, source: serializeKnowledgeSource(existing) });
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    return NextResponse.json(
      { ok: false, error: "no_r2", message: "R2 스토리지 환경변수가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  const r2Key = `knowledge-sources/${sha12}/${safeName(file.name)}`;
  try {
    await storage.putObject({ key: r2Key, body: bytes, contentType: contentTypeForExt(ext) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: "upload_failed", message }, { status: 502 });
  }

  const source = await insertKnowledgeSource({
    kind,
    title,
    sha256,
    r2Key,
    programHint: program,
    institutionHint: institution,
    sourceDate,
    uploadedBy: reviewer.email,
    status: "registered",
  });

  return NextResponse.json({ ok: true, source: serializeKnowledgeSource(source) });
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value && typeof value === "object" && "arrayBuffer" in value && "size" in value && "name" in value,
  );
}

/** 폼 필드를 trim 된 문자열로. 파일/공백은 "" 로. */
function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Phase 3 Preview Viewer 검증용 데모 시드 (docs/plans/2026-07-05-phase3-viewer.md 설계 결정 7).
 *
 * 프로덕션 DB 의 grant_application_surfaces / document_artifacts / grant_document_fields 는
 * conversion E2E(A7) 대기로 0건이다. 뷰어를 실제로 확인하려면 최소 데이터가 필요해서,
 * 이미 검증된 field_map_review_docs 의 실존 페이지 이미지를 재활용해 dev 전용 grant 를 만든다.
 *
 * 동작(--write):
 *   1. field_map_review_docs 에서 페이지 이미지 ≥3, bbox 라벨 ≥4 인 문서를 하나 고른다.
 *   2. 그 문서의 페이지 이미지 3장을 R2 로 복사한다 (grant-convert/dev-seed/<sha16>-p00N.png).
 *   3. dev 전용 grant([DEV-SEED] Phase 3 뷰어 검증) + surface 1건을 upsert 한다.
 *   4. document_artifacts 3행(page_image, metadata {width,height,dpi:220} — PNG IHDR 파싱).
 *   5. grant_document_fields 6행 — 4건은 원 라벨의 실제 bbox·label 을 position 으로 이식, 2건 position null.
 *
 * 기본은 dry-run. --write 로 실제 쓰기. --cleanup 은 grant 삭제(cascade) + R2 dev-seed 오브젝트 삭제.
 *
 * 사용:
 *   pnpm --filter @cunote/web seed:preview-demo                # dry-run
 *   pnpm --filter @cunote/web seed:preview-demo -- --write     # 시드 생성
 *   pnpm --filter @cunote/web seed:preview-demo -- --cleanup   # 정리
 */
import { createHash } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const GRANT_SOURCE = "bizinfo" as const;
const GRANT_SOURCE_ID = "dev-seed-phase3-viewer";
const GRANT_TITLE = "[DEV-SEED] Phase 3 뷰어 검증";
const SURFACE_TYPE = "file_template";
const SURFACE_TITLE = "[DEV-SEED] 사업계획서 양식";
const SURFACE_FORMAT = "hwp";
const SURFACE_ATTACHMENT = "dev-seed-사업계획서.hwp";
const DOCUMENT_NAME = SURFACE_TITLE;
const DOCUMENT_CATEGORY = "business_plan";
const PARSER_VERSION = "dev-seed-v0";
const DEST_PREFIX = "grant-convert/dev-seed";
const DPI = 220;
const PAGE_LIMIT = 3;
const LOCATED_FIELD_LIMIT = 4;

interface LabelField {
  key?: string;
  label?: string;
  section?: string;
  type?: string;
  required?: boolean;
  applicantFills?: boolean;
  manual?: boolean;
  page?: number;
  bbox?: [number, number, number, number] | null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function fail(payload: Record<string, unknown>): never {
  console.error(JSON.stringify({ ok: false, ...payload }, null, 2));
  process.exitCode = 1;
  throw new Error(String(payload.code ?? "seed_failed"));
}

/** PNG IHDR 에서 width/height 를 읽는다. 실패 시 null. */
function parsePngSize(buffer: Buffer): { width: number; height: number } | null {
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function toFieldType(raw: string | undefined): string {
  const allowed = ["text", "long_text", "number", "date", "currency", "checkbox", "table", "file"];
  if (raw && allowed.includes(raw)) return raw;
  if (raw === "signature" || raw === "stamp") return raw;
  return "text";
}

function toFillStrategy(field: LabelField): string {
  if (field.manual) return "manual";
  if (field.applicantFills === false) return "copy";
  return "ask_user";
}

/** 시드 소스로 쓸 검수 문서를 고른다 (페이지 ≥3, bbox 라벨 ≥ LOCATED_FIELD_LIMIT). */
async function pickSource(db: ReturnType<typeof getCunoteDb>) {
  const rows = await db
    .select({
      docId: schema.fieldMapReviewDocs.docId,
      keys: schema.fieldMapReviewDocs.pageImageKeys,
      labelJson: schema.fieldMapReviewDocs.labelJson,
    })
    .from(schema.fieldMapReviewDocs);

  for (const row of rows) {
    const keys = Array.isArray(row.keys) ? row.keys : [];
    const fields = Array.isArray((row.labelJson as { fields?: unknown })?.fields)
      ? ((row.labelJson as { fields: LabelField[] }).fields)
      : [];
    if (keys.length < PAGE_LIMIT) continue;
    // 좌표를 이식할 필드: bbox 있고 페이지가 복사 대상(1..PAGE_LIMIT) 안.
    const located = fields.filter(
      (field) =>
        Array.isArray(field.bbox) &&
        field.bbox.length === 4 &&
        typeof field.page === "number" &&
        field.page >= 1 &&
        field.page <= PAGE_LIMIT &&
        (field.label ?? "").trim().length > 0,
    );
    if (located.length >= LOCATED_FIELD_LIMIT) {
      return {
        docId: row.docId,
        pageKeys: keys.slice(0, PAGE_LIMIT),
        located: located.slice(0, LOCATED_FIELD_LIMIT),
      };
    }
  }
  return null;
}

function makeS3(): { client: S3Client; bucket: string } | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  const endpoint = (process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`)
    .replace(/\/+$/, "");
  return {
    client: new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
    bucket,
  };
}

async function runCleanup() {
  const db = getCunoteDb();
  const grantRows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(and(eq(schema.grants.source, GRANT_SOURCE), eq(schema.grants.sourceId, GRANT_SOURCE_ID)))
    .limit(1);
  const grantId = grantRows[0]?.id ?? null;

  const destKeys: string[] = [];
  if (grantId) {
    const artifactRows = await db
      .select({ storageKey: schema.documentArtifacts.storageKey })
      .from(schema.documentArtifacts)
      .innerJoin(
        schema.grantApplicationSurfaces,
        eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
      )
      .where(eq(schema.grantApplicationSurfaces.grantId, grantId));
    for (const row of artifactRows) {
      if (row.storageKey.startsWith(`${DEST_PREFIX}/`)) destKeys.push(row.storageKey);
    }
  }

  // R2 오브젝트 삭제.
  let r2Deleted = 0;
  const s3 = makeS3();
  if (s3 && destKeys.length) {
    for (const key of destKeys) {
      await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
      r2Deleted += 1;
    }
  }

  // grant 삭제 → surface/artifacts/fields cascade.
  let grantDeleted = 0;
  if (grantId) {
    const deleted = await db
      .delete(schema.grants)
      .where(eq(schema.grants.id, grantId))
      .returning({ id: schema.grants.id });
    grantDeleted = deleted.length;
  }

  console.log(
    JSON.stringify(
      { ok: true, action: "cleanup", grantId, grantDeleted, r2Deleted, r2Keys: destKeys },
      null,
      2,
    ),
  );
}

async function main() {
  if (hasFlag("help")) {
    console.log(
      [
        "Usage: pnpm --filter @cunote/web seed:preview-demo -- [--write] [--cleanup]",
        "",
        "기본은 dry-run. --write 로 시드 생성, --cleanup 으로 정리(grant cascade + R2 삭제).",
      ].join("\n"),
    );
    return;
  }

  if (hasFlag("cleanup")) {
    await runCleanup();
    return;
  }

  const write = hasFlag("write");
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    fail({ code: "r2_not_configured", hint: "R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL 필요" });
  }

  const source = await pickSource(db);
  if (!source) {
    fail({ code: "no_usable_source", hint: "field_map_review_docs 중 페이지≥3·bbox 라벨≥4 문서가 필요합니다." });
  }

  // 페이지 이미지 복사 계획 (dry-run 에서도 IHDR 확인차 원본을 읽는다).
  const pagePlan: Array<{
    page: number;
    sourceKey: string;
    destKey: string;
    width: number | null;
    height: number | null;
    bytes: number;
    body: Buffer | null;
  }> = [];

  for (let index = 0; index < source.pageKeys.length; index += 1) {
    const page = index + 1;
    const sourceKey = source.pageKeys[index] as string;
    const destKey = `${DEST_PREFIX}/${shortHash(sourceKey)}-p00${page}.png`;
    let width: number | null = null;
    let height: number | null = null;
    let bytes = 0;
    let body: Buffer | null = null;
    try {
      const object = await storage!.getObjectBytes(sourceKey);
      body = object.body;
      bytes = object.body.length;
      const size = parsePngSize(object.body);
      if (size) {
        width = size.width;
        height = size.height;
      }
    } catch (error) {
      fail({ code: "source_read_failed", sourceKey, message: (error as Error).message });
    }
    pagePlan.push({ page, sourceKey, destKey, width, height, bytes, body });
  }

  // 필드 6행 계획: 4건 좌표 이식 + 2건 좌표 없음.
  const locatedFields = source.located.map((field, index) => ({
    fieldKey: (field.key && field.key.trim()) || `dev_located_${index + 1}`,
    label: (field.label ?? "").trim() || `항목 ${index + 1}`,
    section: field.section?.trim() ? field.section.trim() : null,
    fieldType: toFieldType(field.type),
    required: Boolean(field.required),
    fillStrategy: toFillStrategy(field),
    confidence: 0.9,
    sourceSpan: (field.label ?? "").trim() || null,
    page: field.page as number,
    bbox: field.bbox as [number, number, number, number],
  }));

  const unlocatedFields = [
    {
      fieldKey: "dev_employee_count",
      label: "상시 근로자 수",
      section: "기업 개요",
      fieldType: "number",
      required: true,
      fillStrategy: "ask_user",
      confidence: 0.6,
      sourceSpan: "상시 근로자 수(명)",
    },
    {
      fieldKey: "dev_ceo_signature",
      label: "대표자 서명",
      section: "확인 및 서명",
      fieldType: "signature",
      required: true,
      fillStrategy: "manual",
      confidence: 0.5,
      sourceSpan: "위 내용은 사실과 다름이 없음을 확인합니다. (서명)",
    },
  ];

  const previewUrlBase = "/grants/{grantId}/preview";

  if (!write) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          sourceDocId: source.docId,
          pages: pagePlan.map((p) => ({
            page: p.page,
            sourceKey: p.sourceKey,
            destKey: p.destKey,
            width: p.width,
            height: p.height,
            bytes: p.bytes,
          })),
          locatedFields: locatedFields.map((f) => ({ label: f.label, page: f.page, bbox: f.bbox })),
          unlocatedFields: unlocatedFields.map((f) => f.label),
          note: "grant/surface/artifacts/fields 는 --write 시 생성됩니다.",
          previewUrl: previewUrlBase,
        },
        null,
        2,
      ),
    );
    return;
  }

  // === WRITE ===
  // 1) R2 복사.
  for (const plan of pagePlan) {
    if (!plan.body) fail({ code: "missing_body", destKey: plan.destKey });
    await storage!.putObject({ key: plan.destKey, body: plan.body as Buffer, contentType: "image/png" });
  }

  // 2) grant upsert.
  const grantRows = await db
    .insert(schema.grants)
    .values({
      source: GRANT_SOURCE,
      sourceId: GRANT_SOURCE_ID,
      title: GRANT_TITLE,
      status: "open",
      overallConfidence: 1,
    })
    .onConflictDoUpdate({
      target: [schema.grants.source, schema.grants.sourceId],
      set: { title: GRANT_TITLE, status: "open", updatedAt: new Date() },
    })
    .returning({ id: schema.grants.id });
  const grantId = grantRows[0]!.id;

  // 3) 기존 dev-seed 자식행 정리(멱등 재실행 대비). grant 는 유지.
  await db.delete(schema.grantDocumentFields).where(eq(schema.grantDocumentFields.grantId, grantId));
  await db
    .delete(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.grantId, grantId));

  // 4) surface.
  const surfaceRows = await db
    .insert(schema.grantApplicationSurfaces)
    .values({
      grantId,
      source: GRANT_SOURCE,
      sourceId: GRANT_SOURCE_ID,
      type: SURFACE_TYPE,
      title: SURFACE_TITLE,
      format: SURFACE_FORMAT,
      sourceAttachment: SURFACE_ATTACHMENT,
      extractionStatus: "fields_ready",
      extractionVersion: PARSER_VERSION,
    })
    .returning({ id: schema.grantApplicationSurfaces.id });
  const surfaceId = surfaceRows[0]!.id;

  // 5) document_artifacts.
  for (const plan of pagePlan) {
    await db.insert(schema.documentArtifacts).values({
      surfaceId,
      kind: "page_image",
      page: plan.page,
      storageKey: plan.destKey,
      contentType: "image/png",
      sha256: plan.body ? sha256Hex(plan.body) : null,
      metadata: { width: plan.width, height: plan.height, dpi: DPI },
    });
  }

  // 6) grant_document_fields (4 located + 2 unlocated).
  for (const field of locatedFields) {
    await db.insert(schema.grantDocumentFields).values({
      grantId,
      source: GRANT_SOURCE,
      sourceId: GRANT_SOURCE_ID,
      documentCategory: DOCUMENT_CATEGORY,
      documentName: DOCUMENT_NAME,
      sourceAttachment: SURFACE_ATTACHMENT,
      fieldKey: field.fieldKey,
      label: field.label,
      section: field.section,
      fieldType: field.fieldType,
      required: field.required,
      sourceSpan: field.sourceSpan,
      fillStrategy: field.fillStrategy,
      confidence: field.confidence,
      parserVersion: PARSER_VERSION,
      surfaceId,
      position: { page: field.page, bbox: field.bbox },
    });
  }
  for (const field of unlocatedFields) {
    await db.insert(schema.grantDocumentFields).values({
      grantId,
      source: GRANT_SOURCE,
      sourceId: GRANT_SOURCE_ID,
      documentCategory: DOCUMENT_CATEGORY,
      documentName: DOCUMENT_NAME,
      sourceAttachment: SURFACE_ATTACHMENT,
      fieldKey: field.fieldKey,
      label: field.label,
      section: field.section,
      fieldType: field.fieldType,
      required: field.required,
      sourceSpan: field.sourceSpan,
      fillStrategy: field.fillStrategy,
      confidence: field.confidence,
      parserVersion: PARSER_VERSION,
      surfaceId,
      position: null,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "write",
        grantId,
        surfaceId,
        sourceDocId: source.docId,
        pagesWritten: pagePlan.map((p) => ({ page: p.page, destKey: p.destKey, width: p.width, height: p.height })),
        fieldsWritten: locatedFields.length + unlocatedFields.length,
        locatedFields: locatedFields.length,
        previewUrl: `/grants/${grantId}/preview`,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    if (!process.exitCode) {
      console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
      process.exitCode = 1;
    }
  })
  .finally(async () => {
    await closeCunoteDb();
  });

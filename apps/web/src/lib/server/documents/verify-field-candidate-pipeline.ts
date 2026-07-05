/**
 * Phase 4 [F] 검증 스크립트 — 필드 후보 파이프라인 실DB·실R2 왕복 (설계 결정 검증 스크립트).
 *
 * 흐름:
 *   1. dev 전용 grant + surface 생성 ([DEV-SEED] 관례, cascade 삭제).
 *   2. 합성 layout CandidateSet + text parser 실후보(고정 마크다운 → extractGrantDocumentFields
 *      → toTextParserCandidateSet) 를 fieldCandidateStore 로 save.
 *   3. loadFieldCandidates → 2개 CandidateSet 왕복 assert.
 *   4. reconcileFieldCandidates → applyReconciledFields.
 *   5. loadGrantDocumentPreview 가 position(box) 있는 필드를 반환하는지 assert.
 *   6. 전량 cleanup(grant cascade + R2 field_candidates 삭제) 후 잔여 0건 assert.
 *
 * 실행형(dry-run 아님). 종료 시 자체 정리.
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *     apps/web/src/lib/server/documents/verify-field-candidate-pipeline.ts
 */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import type { RequiredDocument } from "@cunote/contracts";
import {
  extractGrantDocumentFields,
  reconcileFieldCandidates,
  toTextParserCandidateSet,
  type CandidateSet,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createFieldCandidateStore, FIELD_CANDIDATES_ARTIFACT_KIND } from "./fieldCandidateStore";
import { applyReconciledFields } from "./applyReconciledFields";
import { loadGrantDocumentPreview } from "./documentPreview";

loadMonorepoEnv();

const GRANT_SOURCE = "bizinfo" as const;
const GRANT_SOURCE_ID = "dev-seed-phase4-field-candidates";
const GRANT_TITLE = "[DEV-SEED] Phase 4 필드후보 파이프라인";
const SURFACE_TITLE = "[DEV-SEED] 사업계획서 양식 (P4)";
const SURFACE_ATTACHMENT = "dev-seed-p4-사업계획서.hwp";

const FIXED_MARKDOWN = [
  "| 항목 | 작성란 |",
  "| --- | --- |",
  "| 기업명 |  |",
  "| 사업자등록번호 |  |",
  "| 대표자 서명 |  |",
].join("\n");

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function makeS3(): { client: S3Client; bucket: string } | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  const endpoint = (process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`).replace(
    /\/+$/,
    "",
  );
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

function syntheticLayoutSet(): CandidateSet {
  return {
    engine: "synthetic-layout",
    engineVersion: "verify-1",
    layer: "layout",
    extractedAt: new Date().toISOString(),
    candidates: [
      {
        page: 1,
        bbox: [0.28, 0.16, 0.15, 0.04],
        bboxSource: "layout",
        layer: "layout",
        kind: "text_input",
        label: "사업자등록번호",
        text: "",
        confidence: 0.9,
        rotationDeg: null,
        raw: {},
      },
      {
        page: 1,
        bbox: [0.2, 0.57, 0.3, 0.03],
        bboxSource: "layout",
        layer: "layout",
        kind: "signature",
        label: "대표자 서명",
        text: "",
        confidence: 0.88,
        rotationDeg: null,
        raw: {},
      },
    ],
  };
}

function textParserSet(): CandidateSet {
  const documents: RequiredDocument[] = [
    {
      name: "사업계획서",
      required: true,
      source: "self",
      category: "application_form",
      preparationType: "write",
      canonicalName: "사업계획서",
      sourceAttachment: SURFACE_ATTACHMENT,
    },
  ];
  const fields = extractGrantDocumentFields({
    documents,
    attachmentMarkdowns: [{ filename: SURFACE_ATTACHMENT, markdown: FIXED_MARKDOWN }],
  });
  return toTextParserCandidateSet(fields, { engine: "text-parser", extractedAt: new Date().toISOString() });
}

interface CleanupResult {
  grantDeleted: number;
  r2Deleted: number;
  residualGrants: number;
  residualSurfaces: number;
  residualR2: number;
}

async function cleanup(db: ReturnType<typeof getCunoteDb>): Promise<CleanupResult> {
  // grant id (없으면 이미 정리됨).
  const grantRows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(and(eq(schema.grants.source, GRANT_SOURCE), eq(schema.grants.sourceId, GRANT_SOURCE_ID)))
    .limit(1);
  const grantId = grantRows[0]?.id ?? null;

  // field_candidates R2 키 수집 (grant 삭제 전).
  const r2Keys: string[] = [];
  if (grantId) {
    const artifactRows = await db
      .select({ storageKey: schema.documentArtifacts.storageKey, kind: schema.documentArtifacts.kind })
      .from(schema.documentArtifacts)
      .innerJoin(
        schema.grantApplicationSurfaces,
        eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
      )
      .where(eq(schema.grantApplicationSurfaces.grantId, grantId));
    for (const row of artifactRows) {
      if (row.kind === FIELD_CANDIDATES_ARTIFACT_KIND) r2Keys.push(row.storageKey);
    }
  }

  // R2 삭제.
  let r2Deleted = 0;
  const s3 = makeS3();
  if (s3) {
    for (const key of r2Keys) {
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

  // 잔여 검사.
  const residualGrantRows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(and(eq(schema.grants.source, GRANT_SOURCE), eq(schema.grants.sourceId, GRANT_SOURCE_ID)));
  const residualSurfaceRows = await db
    .select({ id: schema.grantApplicationSurfaces.id })
    .from(schema.grantApplicationSurfaces)
    .where(
      and(
        eq(schema.grantApplicationSurfaces.source, GRANT_SOURCE),
        eq(schema.grantApplicationSurfaces.sourceId, GRANT_SOURCE_ID),
      ),
    );

  let residualR2 = 0;
  const storage = createR2ObjectStorageFromEnv();
  if (storage) {
    for (const key of r2Keys) {
      if (await storage.objectExists(key)) residualR2 += 1;
    }
  }

  return {
    grantDeleted,
    r2Deleted,
    residualGrants: residualGrantRows.length,
    residualSurfaces: residualSurfaceRows.length,
    residualR2,
  };
}

async function main() {
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  assert(storage, "R2 미설정 — R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL 필요");

  // 재실행 대비: 시작 전 기존 잔재 정리.
  await cleanup(db);

  let cleaned = false;
  try {
    // 1) grant + surface.
    const grantRows = await db
      .insert(schema.grants)
      .values({ source: GRANT_SOURCE, sourceId: GRANT_SOURCE_ID, title: GRANT_TITLE, status: "open", overallConfidence: 1 })
      .onConflictDoUpdate({
        target: [schema.grants.source, schema.grants.sourceId],
        set: { title: GRANT_TITLE, status: "open", updatedAt: new Date() },
      })
      .returning({ id: schema.grants.id });
    const grantId = grantRows[0]!.id;

    const surfaceRows = await db
      .insert(schema.grantApplicationSurfaces)
      .values({
        grantId,
        source: GRANT_SOURCE,
        sourceId: GRANT_SOURCE_ID,
        type: "file_template",
        title: SURFACE_TITLE,
        format: "hwp",
        sourceAttachment: SURFACE_ATTACHMENT,
        extractionStatus: "preview_ready",
        extractionVersion: "verify-p4",
      })
      .returning({ id: schema.grantApplicationSurfaces.id });
    const surfaceId = surfaceRows[0]!.id;

    // 2) save (layout + text parser).
    const store = createFieldCandidateStore({ db, storage });
    const layoutSet = syntheticLayoutSet();
    const textSet = textParserSet();
    assert(textSet.candidates.length > 0, "text parser 후보 0건 — 고정 마크다운 추출 실패");
    assert(
      textSet.candidates.some((c) => c.label === "사업자등록번호"),
      "text parser 후보에 사업자등록번호 라벨 없음 — rule ① 매칭 불가",
    );

    const savedLayout = await store.saveFieldCandidates({ surfaceId, set: layoutSet });
    const savedText = await store.saveFieldCandidates({ surfaceId, set: textSet });
    assert(savedLayout.created && savedText.created, "최초 save 가 insert 가 아님");

    // 멱등 재저장 → update.
    const resave = await store.saveFieldCandidates({ surfaceId, set: layoutSet });
    assert(!resave.created, "동일 엔진 재저장이 update 가 아님 (멱등 위반)");

    // 3) load 왕복.
    const loaded = await store.loadFieldCandidates(surfaceId);
    assert(loaded.length === 2, `load 된 CandidateSet 이 2개가 아님: ${loaded.length}`);
    const loadedText = loaded.find((s) => s.layer === "text_parser");
    assert(loadedText && loadedText.candidates.length === textSet.candidates.length, "text_parser 후보 왕복 불일치");

    // 4) reconcile → apply.
    const reconciled = reconcileFieldCandidates(loaded);
    assert(reconciled.length > 0, "reconciled 필드 0건");
    const located = reconciled.filter((f) => f.position && f.position.bbox);
    assert(located.length > 0, "position 있는 reconciled 필드 0건 (rule ① 미작동)");
    const bizField = reconciled.find((f) => f.fieldKey === "company.biz_no");
    assert(bizField && bizField.tier === "high" && bizField.position != null, "사업자등록번호 high+position 아님");
    const signatureField = reconciled.find((f) => f.fillStrategy === "manual");
    assert(signatureField, "manual(서명) 필드 없음 (rule ④ 미작동)");

    const applied = await applyReconciledFields({
      db,
      surfaceId,
      fields: reconciled,
      defaults: { documentCategory: "application_form", documentName: SURFACE_TITLE },
    });
    assert(applied.extractionStatus === "fields_ready", "surface 가 fields_ready 로 전이되지 않음");
    assert(applied.inserted > 0, "grant_document_fields insert 0건");

    // 5) P3 뷰어 로더가 position 있는 필드를 반환하는지.
    const preview = await loadGrantDocumentPreview({ grantId });
    assert(preview, "loadGrantDocumentPreview null");
    const previewLocated = preview.fields.filter((f) => f.box !== null);
    assert(previewLocated.length > 0, "뷰어 로더가 position 있는 필드를 반환하지 않음");
    const previewSurface = preview.surfaces.find((s) => s.id === surfaceId);
    assert(previewSurface?.extractionStatus === "fields_ready", "뷰어 surface extraction_status 가 fields_ready 아님");

    // 6) cleanup + 잔여 0건.
    const cleanupResult = await cleanup(db);
    cleaned = true;
    assert(cleanupResult.grantDeleted === 1, `grant 삭제 1건 아님: ${cleanupResult.grantDeleted}`);
    assert(cleanupResult.residualGrants === 0, `잔여 grant: ${cleanupResult.residualGrants}`);
    assert(cleanupResult.residualSurfaces === 0, `잔여 surface: ${cleanupResult.residualSurfaces}`);
    assert(cleanupResult.residualR2 === 0, `잔여 R2 오브젝트: ${cleanupResult.residualR2}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          checked: [
            "grant_surface_seed",
            "save_layout_and_text_candidates",
            "save_idempotent_update",
            "load_roundtrip_2_sets",
            "reconcile_rules_high_manual_position",
            "apply_upsert_fields_ready",
            "preview_loader_returns_position",
            "full_cleanup_zero_residual",
          ],
          grantId,
          surfaceId,
          reconciledFields: reconciled.length,
          locatedFields: located.length,
          appliedInserted: applied.inserted,
          previewLocated: previewLocated.length,
          cleanup: cleanupResult,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!cleaned) {
      // 실패 경로: 잔재 남기지 않기 위해 정리 시도.
      try {
        await cleanup(db);
      } catch {
        // 정리 실패는 원 에러를 가리지 않게 무시.
      }
    }
    await closeCunoteDb();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
  process.exitCode = 1;
});

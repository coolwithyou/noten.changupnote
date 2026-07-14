/**
 * 슬라이스 B 검증 스크립트 — 검수 큐 유입(B1) → 승인 반영(B3) 실DB 왕복 (설계 결정 검증).
 *
 * 정본: docs/plans/2026-07-08-ideal-flow-vertical-slice.md "슬라이스 B".
 *
 * 흐름(실행형, dry-run 아님 — 자체 정리):
 *   1. sim grant(open) + surface(preview_ready) + page_image artifact 2장 생성.
 *   2. B1 importReviewDocsFromSurfaces: dry-run 은 미기록, --write 는 field_map_review_docs 등재 assert.
 *      재실행 멱등(이미 등재분 skip) assert.
 *   3. B2 parsePrelabelResponse 순수 파서 단위 검증(고정 fixture — 실 LLM 호출 없음).
 *   4. 사전라벨 대체: labelJson.fields 주입(GUI 형태 2필드) — pending 유지.
 *   5. sim 리뷰어(sim-reviewer@ba-ton.kr) approveReviewDoc → grant_document_fields 반영 +
 *      surface fields_ready + golden 승격 assert.
 *   6. unapproveReviewDoc → reconcile-v0 필드 철회 + surface preview_ready 롤백 assert.
 *   7. 전량 cleanup(review docs + golden + grant cascade) 후 잔여 0건 assert.
 *
 * 실행:
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *     apps/web/src/lib/server/documents/verify-review-surface-bridge.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { importReviewDocsFromSurfaces } from "../db/import-review-docs-from-surfaces";
import { approveReviewDoc, unapproveReviewDoc } from "../review/reviewDocsRepo";
import { RECONCILE_PARSER_VERSION } from "./applyReconciledFields";
import { loadGrantDocumentPreview } from "./documentPreview";
import { parsePrelabelResponse } from "./reviewFieldMapping";

loadMonorepoEnv();

const GRANT_SOURCE = "kstartup" as const;
const GRANT_SOURCE_ID = "sim-review-surface-bridge";
const GRANT_TITLE = "[SIM] 검수 브리지 세로관통";
const SURFACE_TITLE = "[SIM] 사업계획서 양식.pdf";
const SURFACE_ATTACHMENT = "grant-convert/sim/review-surface-bridge/attachment.pdf";
const REVIEWER_EMAIL = "sim-reviewer@ba-ton.kr";

// 주입할 사전라벨 대체 필드(검수 GUI 형태). 하나는 서명(coerce+manual) 케이스.
const INJECTED_FIELDS = [
  {
    key: "company_name",
    label: "기업명",
    section: "신청기업 현황",
    type: "text",
    required: true,
    applicantFills: true,
    manual: false,
    page: 1,
    bbox: [0.12, 0.31, 0.45, 0.03],
    notes: "",
  },
  {
    key: "rep_signature",
    label: "대표자 서명",
    section: "확인",
    type: "signature", // coerce → text, manual 강제
    required: true,
    applicantFills: true,
    manual: true,
    page: 2,
    bbox: [0.2, 0.8, 0.3, 0.05],
    notes: "",
  },
] as const;

const PRELABEL_FIXTURE = JSON.stringify({
  fields: [
    {
      label: "기업명",
      fieldKey: "Company Name", // slug 정규화 대상
      fieldType: "text",
      required: true,
      manual: false,
      section: "신청기업 현황",
      page: 1,
      bbox: [0.12, 0.31, 0.45, 0.03],
      sourceSpan: "기업명",
    },
    {
      label: "대표자 서명",
      fieldType: "signature", // → manual 유도
      required: true,
      section: "확인",
      page: 2,
      bbox: [1.2, 0.8, 0.3, 0.05], // 범위 이탈 → bbox null
      sourceSpan: "",
    },
    { label: "" }, // 빈 label → 드롭
  ],
});

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

type Db = ReturnType<typeof getCunoteDb>;

async function findGrantId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(and(eq(schema.grants.source, GRANT_SOURCE), eq(schema.grants.sourceId, GRANT_SOURCE_ID)))
    .limit(1);
  return rows[0]?.id ?? null;
}

interface CleanupResult {
  grantDeleted: number;
  reviewDocsDeleted: number;
  goldenDeleted: number;
  residualGrants: number;
  residualSurfaces: number;
  residualReviewDocs: number;
}

async function cleanup(db: Db): Promise<CleanupResult> {
  const grantId = await findGrantId(db);

  // surface 들과 그로부터 파생된 docRef(surface:<id>) 수집.
  const surfaceRows = grantId
    ? await db
        .select({ id: schema.grantApplicationSurfaces.id })
        .from(schema.grantApplicationSurfaces)
        .where(eq(schema.grantApplicationSurfaces.grantId, grantId))
    : [];
  const docRefs = surfaceRows.map((r) => `surface:${r.id}`);

  let reviewDocsDeleted = 0;
  let goldenDeleted = 0;
  if (docRefs.length > 0) {
    const g = await db
      .delete(schema.goldenSet)
      .where(and(eq(schema.goldenSet.kind, "field_map"), inArray(schema.goldenSet.ref, docRefs)))
      .returning({ id: schema.goldenSet.id });
    goldenDeleted = g.length;
    const r = await db
      .delete(schema.fieldMapReviewDocs)
      .where(inArray(schema.fieldMapReviewDocs.docRef, docRefs))
      .returning({ id: schema.fieldMapReviewDocs.id });
    reviewDocsDeleted = r.length;
  }

  let grantDeleted = 0;
  if (grantId) {
    const deleted = await db
      .delete(schema.grants)
      .where(eq(schema.grants.id, grantId))
      .returning({ id: schema.grants.id });
    grantDeleted = deleted.length;
  }

  const residualGrants = (await findGrantId(db)) ? 1 : 0;
  const residualSurfaceRows = await db
    .select({ id: schema.grantApplicationSurfaces.id })
    .from(schema.grantApplicationSurfaces)
    .where(
      and(
        eq(schema.grantApplicationSurfaces.source, GRANT_SOURCE),
        eq(schema.grantApplicationSurfaces.sourceId, GRANT_SOURCE_ID),
      ),
    );
  const residualReviewDocRows =
    docRefs.length > 0
      ? await db
          .select({ id: schema.fieldMapReviewDocs.id })
          .from(schema.fieldMapReviewDocs)
          .where(inArray(schema.fieldMapReviewDocs.docRef, docRefs))
      : [];

  return {
    grantDeleted,
    reviewDocsDeleted,
    goldenDeleted,
    residualGrants,
    residualSurfaces: residualSurfaceRows.length,
    residualReviewDocs: residualReviewDocRows.length,
  };
}

async function main() {
  const db = getCunoteDb();

  // 재실행 대비: 시작 전 잔재 정리.
  await cleanup(db);

  let cleaned = false;
  try {
    // 1) sim grant + surface + page_image artifacts.
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
        format: "pdf",
        sourceAttachment: SURFACE_ATTACHMENT,
        extractionStatus: "preview_ready",
      })
      .returning({ id: schema.grantApplicationSurfaces.id });
    const surfaceId = surfaceRows[0]!.id;

    await db.insert(schema.documentArtifacts).values([
      {
        surfaceId,
        kind: "page_image",
        page: 1,
        storageKey: `grant-convert/sim/review-surface-bridge/${surfaceId}-p001.png`,
        contentType: "image/png",
        metadata: { width: 827, height: 1169, dpi: 220 },
      },
      {
        surfaceId,
        kind: "page_image",
        page: 2,
        storageKey: `grant-convert/sim/review-surface-bridge/${surfaceId}-p002.png`,
        contentType: "image/png",
        metadata: { width: 827, height: 1169, dpi: 220 },
      },
    ]);

    // 2a) B1 dry-run — 미기록 확인.
    const dry = await importReviewDocsFromSurfaces({ db, surfaceId, write: false });
    assert(dry.dryRun === true, "dry-run 플래그가 아님");
    assert(dry.decisions.some((d) => d.surfaceId === surfaceId && d.action === "insert"), "dry-run 후보에 sim surface 없음");
    const afterDry = await db
      .select({ id: schema.fieldMapReviewDocs.id })
      .from(schema.fieldMapReviewDocs)
      .where(eq(schema.fieldMapReviewDocs.docRef, `surface:${surfaceId}`));
    assert(afterDry.length === 0, "dry-run 인데 review doc 이 기록됨");

    // 2b) B1 write — 등재.
    const wrote = await importReviewDocsFromSurfaces({ db, surfaceId, write: true });
    assert(wrote.totals.inserted === 1, `등재 1건 아님: ${wrote.totals.inserted}`);
    const decision = wrote.decisions.find((d) => d.surfaceId === surfaceId);
    assert(decision?.docRef === `surface:${surfaceId}`, "docRef 규약 불일치");
    assert(decision?.pageImageCount === 2, `page_image 2 아님: ${decision?.pageImageCount}`);
    const docId = decision!.docId;
    assert(docId.startsWith("s-"), `docId 규약(s-) 아님: ${docId}`);

    const [reviewRow] = await db
      .select()
      .from(schema.fieldMapReviewDocs)
      .where(eq(schema.fieldMapReviewDocs.docRef, `surface:${surfaceId}`))
      .limit(1);
    assert(reviewRow, "등재된 review doc 을 찾지 못함");
    assert(Array.isArray(reviewRow!.pageImageKeys) && reviewRow!.pageImageKeys.length === 2, "pageImageKeys 2 아님");
    const initialFields = (reviewRow!.labelJson as { fields?: unknown[] }).fields ?? [];
    assert(Array.isArray(initialFields) && initialFields.length === 0, "초기 fields 가 비어있지 않음");
    assert(reviewRow!.reviewStatus === "pending", "초기 상태 pending 아님");

    // 2c) 멱등: 재실행 시 재등재 안 됨.
    const again = await importReviewDocsFromSurfaces({ db, surfaceId, write: true });
    assert(again.totals.inserted === 0, `멱등 위반 — 재등재됨: ${again.totals.inserted}`);

    // 3) B2 파서 단위 검증(고정 fixture).
    const parsed = parsePrelabelResponse(PRELABEL_FIXTURE);
    assert(parsed.fields.length === 2, `파서 필드 2 아님: ${parsed.fields.length}`);
    assert(parsed.dropped.length === 1, `빈 label 드롭 1 아님: ${parsed.dropped.length}`);
    assert(parsed.fields[0]!.fieldKey === "company_name", `slug 정규화 실패: ${parsed.fields[0]!.fieldKey}`);
    assert(parsed.fields[1]!.manual === true, "signature → manual 유도 실패");
    assert(parsed.fields[1]!.fieldType === "text", "signature → text coerce 실패");
    assert(parsed.fields[1]!.bbox === null, "범위 이탈 bbox 가 null 로 정규화되지 않음");

    // 4) 사전라벨 대체: fields 주입(pending 유지).
    const labelJsonWithFields = {
      ...(reviewRow!.labelJson as Record<string, unknown>),
      fields: INJECTED_FIELDS,
      labeledBy: "ai:claude-sonnet-5",
      labeledAt: new Date().toISOString().slice(0, 10),
    };
    await db
      .update(schema.fieldMapReviewDocs)
      .set({ labelJson: labelJsonWithFields, labeledBy: "ai:claude-sonnet-5", updatedAt: new Date() })
      .where(eq(schema.fieldMapReviewDocs.id, reviewRow!.id));

    // 5) 승인 반영.
    const approve = await approveReviewDoc(docId, REVIEWER_EMAIL);
    assert(approve.ok, `승인 실패: ${approve.ok ? "" : approve.reason}`);
    assert(approve.ok && approve.applied, "applied 반영 결과 없음");
    assert(approve.ok && approve.applied!.surfaceId === surfaceId, "applied surfaceId 불일치");
    assert(approve.ok && approve.applied!.inserted === 2, `반영 필드 2 아님: ${approve.ok ? approve.applied!.inserted : "-"}`);
    assert(approve.ok && approve.applied!.extractionStatus === "fields_ready", "surface fields_ready 아님");

    const fieldRows = await db
      .select({
        fieldKey: schema.grantDocumentFields.fieldKey,
        fieldType: schema.grantDocumentFields.fieldType,
        fillStrategy: schema.grantDocumentFields.fillStrategy,
        mappedCompanyField: schema.grantDocumentFields.mappedCompanyField,
        confidence: schema.grantDocumentFields.confidence,
        parserVersion: schema.grantDocumentFields.parserVersion,
        reviewRequired: schema.grantDocumentFields.reviewRequired,
      })
      .from(schema.grantDocumentFields)
      .where(eq(schema.grantDocumentFields.surfaceId, surfaceId));
    assert(fieldRows.length === 2, `grant_document_fields 2 아님: ${fieldRows.length}`);
    assert(fieldRows.every((r) => r.parserVersion === RECONCILE_PARSER_VERSION), "parser_version reconcile-v0 아님");
    assert(fieldRows.every((r) => r.confidence === 1), "confidence 1 아님");
    assert(fieldRows.every((r) => r.reviewRequired === false), "reviewRequired false 아님");
    const sig = fieldRows.find((r) => r.fieldKey === "rep_signature");
    assert(sig?.fieldType === "text", `signature coerce → text 아님: ${sig?.fieldType}`);
    assert(sig?.fillStrategy === "manual", `signature fillStrategy manual 아님: ${sig?.fillStrategy}`);
    const companyName = fieldRows.find((r) => r.fieldKey === "company_name");
    assert(companyName, "company_name 필드 없음");
    assert(companyName.mappedCompanyField === "name", `company_name 프로필 매핑 아님: ${companyName.mappedCompanyField}`);
    assert(companyName.fillStrategy === "copy", `company_name fillStrategy copy 아님: ${companyName.fillStrategy}`);

    const [surfAfterApprove] = await db
      .select({ status: schema.grantApplicationSurfaces.extractionStatus })
      .from(schema.grantApplicationSurfaces)
      .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
      .limit(1);
    assert(surfAfterApprove?.status === "fields_ready", "승인 후 surface fields_ready 아님");

    const goldenAfter = await db
      .select({ id: schema.goldenSet.id })
      .from(schema.goldenSet)
      .where(and(eq(schema.goldenSet.kind, "field_map"), eq(schema.goldenSet.ref, `surface:${surfaceId}`)));
    assert(goldenAfter.length === 1, `golden 승격 1 아님: ${goldenAfter.length}`);

    // 뷰어 로더가 반영 필드(좌표 포함)를 반환하는지 — 사용자 화면 데이터 공급 증명.
    const preview = await loadGrantDocumentPreview({ grantId });
    assert(preview, "preview 로더 null");
    assert(preview!.fields.length === 2, `preview 필드 2 아님: ${preview!.fields.length}`);
    assert(preview!.fields.some((f) => f.box !== null), "preview 에 좌표(box) 있는 필드가 없음");

    // 6) 반영 철회.
    const unapprove = await unapproveReviewDoc(docId);
    assert(unapprove.ok, `취소 실패: ${unapprove.ok ? "" : unapprove.reason}`);
    assert(unapprove.ok && unapprove.withdrawn, "withdrawn 철회 결과 없음");
    assert(unapprove.ok && unapprove.withdrawn!.fieldsDeleted === 2, `철회 필드 2 아님: ${unapprove.ok ? unapprove.withdrawn!.fieldsDeleted : "-"}`);
    assert(unapprove.ok && unapprove.withdrawn!.extractionStatus === "preview_ready", "철회 후 preview_ready 아님");

    const fieldsAfterWithdraw = await db
      .select({ id: schema.grantDocumentFields.id })
      .from(schema.grantDocumentFields)
      .where(
        and(
          eq(schema.grantDocumentFields.surfaceId, surfaceId),
          eq(schema.grantDocumentFields.parserVersion, RECONCILE_PARSER_VERSION),
        ),
      );
    assert(fieldsAfterWithdraw.length === 0, `철회 후 reconcile-v0 필드 잔존: ${fieldsAfterWithdraw.length}`);

    const [surfAfterWithdraw] = await db
      .select({ status: schema.grantApplicationSurfaces.extractionStatus })
      .from(schema.grantApplicationSurfaces)
      .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
      .limit(1);
    assert(surfAfterWithdraw?.status === "preview_ready", "철회 후 surface preview_ready 아님");

    const goldenAfterWithdraw = await db
      .select({ id: schema.goldenSet.id })
      .from(schema.goldenSet)
      .where(and(eq(schema.goldenSet.kind, "field_map"), eq(schema.goldenSet.ref, `surface:${surfaceId}`)));
    assert(goldenAfterWithdraw.length === 0, `철회 후 golden 잔존: ${goldenAfterWithdraw.length}`);

    const [reviewAfterWithdraw] = await db
      .select({ status: schema.fieldMapReviewDocs.reviewStatus })
      .from(schema.fieldMapReviewDocs)
      .where(eq(schema.fieldMapReviewDocs.docRef, `surface:${surfaceId}`))
      .limit(1);
    assert(reviewAfterWithdraw?.status === "in_review", "철회 후 review 상태 in_review 아님");

    // 7) cleanup + 잔여 0건.
    const cleanupResult = await cleanup(db);
    cleaned = true;
    assert(cleanupResult.grantDeleted === 1, `grant 삭제 1건 아님: ${cleanupResult.grantDeleted}`);
    assert(cleanupResult.residualGrants === 0, `잔여 grant: ${cleanupResult.residualGrants}`);
    assert(cleanupResult.residualSurfaces === 0, `잔여 surface: ${cleanupResult.residualSurfaces}`);
    assert(cleanupResult.residualReviewDocs === 0, `잔여 review doc: ${cleanupResult.residualReviewDocs}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          checked: [
            "sim_grant_surface_artifacts_seed",
            "b1_dry_run_no_write",
            "b1_write_registers_review_doc",
            "b1_idempotent_reregister_skip",
            "b2_parse_prelabel_fixture",
            "b3_approve_reflects_fields_ready",
            "b3_fields_reconcile_v0_confidence1",
            "b3_signature_coerce_manual",
            "preview_loader_returns_fields",
            "b3_unapprove_withdraws_preview_ready",
            "full_cleanup_zero_residual",
          ],
          grantId,
          surfaceId,
          docId,
          appliedInserted: approve.ok ? approve.applied!.inserted : 0,
          withdrawnDeleted: unapprove.ok ? unapprove.withdrawn!.fieldsDeleted : 0,
          cleanup: cleanupResult,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!cleaned) {
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

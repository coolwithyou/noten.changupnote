/**
 * 승인된 surface 검수 필드의 mapped_company_field/fill_strategy를 최신 결정론 planner로 재반영한다.
 *
 * 기본은 dry-run이며 단일 surface UUID가 필수다. 실제 반영은 명시 confirmation을 요구하고,
 * 승인 필드와 기존 필드의 key 집합이 정확히 같을 때 두 계획 컬럼만 갱신한다.
 */
import { and, eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { reviewFieldsToReconciled, type ReviewLabelField } from "./reviewFieldMapping";

loadMonorepoEnv();

const surfaceId = readArg("surfaceId");
const write = process.argv.includes("--write");
if (!surfaceId || !isUuid(surfaceId)) throw new Error("--surfaceId=<uuid>가 필요합니다.");
if (write && readArg("confirm") !== "BACKFILL_REVIEWED_FIELD_FILL_PLANS") {
  throw new Error("--write requires --confirm=BACKFILL_REVIEWED_FIELD_FILL_PLANS");
}

const db = getCunoteDb();
try {
  const [surface] = await db
    .select({
      id: schema.grantApplicationSurfaces.id,
      grantId: schema.grantApplicationSurfaces.grantId,
      title: schema.grantApplicationSurfaces.title,
      source: schema.grantApplicationSurfaces.source,
      sourceId: schema.grantApplicationSurfaces.sourceId,
    })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
    .limit(1);
  if (!surface) throw new Error(`surface를 찾을 수 없습니다: ${surfaceId}`);

  const [review] = await db
    .select({
      reviewStatus: schema.fieldMapReviewDocs.reviewStatus,
      labelJson: schema.fieldMapReviewDocs.labelJson,
    })
    .from(schema.fieldMapReviewDocs)
    .where(eq(schema.fieldMapReviewDocs.docRef, `surface:${surfaceId}`))
    .limit(1);
  if (!review) throw new Error(`surface 검수 문서를 찾을 수 없습니다: ${surfaceId}`);
  if (review.reviewStatus !== "approved") {
    throw new Error(`승인된 검수 문서만 재반영할 수 있습니다: ${review.reviewStatus}`);
  }

  const labelFields = Array.isArray(review.labelJson.fields)
    ? review.labelJson.fields as ReviewLabelField[]
    : [];
  const reconciled = reviewFieldsToReconciled(labelFields);
  const currentRows = await db
    .select({
      id: schema.grantDocumentFields.id,
      fieldKey: schema.grantDocumentFields.fieldKey,
      mappedCompanyField: schema.grantDocumentFields.mappedCompanyField,
      fillStrategy: schema.grantDocumentFields.fillStrategy,
    })
    .from(schema.grantDocumentFields)
    .where(eq(schema.grantDocumentFields.surfaceId, surfaceId));
  const currentByKey = new Map(currentRows.map((row) => [row.fieldKey, row]));
  const reconciledByKey = new Map(reconciled.map((field) => [field.fieldKey, field]));
  if (currentByKey.size !== currentRows.length) {
    throw new Error("기존 필드에 중복 fieldKey가 있어 보정을 중단합니다.");
  }
  if (reconciledByKey.size !== reconciled.length) {
    throw new Error("승인 검수 필드에 중복 fieldKey가 있어 보정을 중단합니다.");
  }
  const missingInDatabase = [...reconciledByKey.keys()].filter((fieldKey) => !currentByKey.has(fieldKey));
  const missingInReview = [...currentByKey.keys()].filter((fieldKey) => !reconciledByKey.has(fieldKey));
  if (missingInDatabase.length > 0 || missingInReview.length > 0) {
    throw new Error(JSON.stringify({
      message: "승인 필드와 기존 필드의 key 집합이 달라 보정을 중단합니다.",
      missingInDatabase,
      missingInReview,
    }));
  }

  const changes = reconciled.flatMap((field) => {
    const current = currentByKey.get(field.fieldKey)!;
    if (
      current.mappedCompanyField === field.mappedCompanyField
      && current.fillStrategy === field.fillStrategy
    ) return [];
    return [{
      id: current.id,
      fieldKey: field.fieldKey,
      before: { mappedCompanyField: current.mappedCompanyField, fillStrategy: current.fillStrategy },
      after: { mappedCompanyField: field.mappedCompanyField, fillStrategy: field.fillStrategy },
    }];
  });

  let applied: { surfaceId: string; updated: number } | null = null;
  if (write && changes.length > 0) {
    applied = await db.transaction(async (tx) => {
      let updated = 0;
      for (const change of changes) {
        const rows = await tx
          .update(schema.grantDocumentFields)
          .set({
            mappedCompanyField: change.after.mappedCompanyField,
            fillStrategy: change.after.fillStrategy,
          })
          .where(and(
            eq(schema.grantDocumentFields.id, change.id),
            eq(schema.grantDocumentFields.surfaceId, surfaceId),
          ))
          .returning({ id: schema.grantDocumentFields.id });
        if (rows.length !== 1) {
          throw new Error(`필드 계획 갱신에 실패했습니다: ${change.fieldKey}`);
        }
        updated += 1;
      }
      return { surfaceId, updated };
    });
  }

  console.log(JSON.stringify({
    dryRun: !write,
    surface,
    reviewedFieldCount: reconciled.length,
    existingFieldCount: currentRows.length,
    changedFieldCount: changes.length,
    changes: changes.map(({ id: _id, ...change }) => change),
    applied,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

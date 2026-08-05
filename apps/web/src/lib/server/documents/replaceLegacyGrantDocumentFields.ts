import { GRANT_DOCUMENT_FIELD_PARSER_VERSION } from "@cunote/core";
import { and, eq } from "drizzle-orm";
import type { CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface LegacyGrantDocumentFieldReplacementResult {
  deletedCount: number;
  insertedCount: number;
}

/**
 * legacy markdown 추출기가 소유한 projection만 원자적으로 교체한다.
 * Kordoc·사람 검수·reconcile 등 다른 parser가 만든 필드는 절대 삭제하지 않는다.
 */
export async function replaceLegacyGrantDocumentFields(input: {
  db: CunoteDb;
  grantId: string;
  fields: Array<typeof schema.grantDocumentFields.$inferInsert>;
}): Promise<LegacyGrantDocumentFieldReplacementResult> {
  return input.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.grantDocumentFields)
      .where(and(
        eq(schema.grantDocumentFields.grantId, input.grantId),
        eq(schema.grantDocumentFields.parserVersion, GRANT_DOCUMENT_FIELD_PARSER_VERSION),
      ))
      .returning({ id: schema.grantDocumentFields.id });

    if (input.fields.length > 0) {
      await tx.insert(schema.grantDocumentFields).values(input.fields);
    }

    return {
      deletedCount: deleted.length,
      insertedCount: input.fields.length,
    };
  });
}

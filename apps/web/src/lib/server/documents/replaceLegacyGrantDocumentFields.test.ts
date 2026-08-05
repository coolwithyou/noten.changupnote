import assert from "node:assert/strict";
import { GRANT_DOCUMENT_FIELD_PARSER_VERSION } from "@cunote/core";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDb } from "@/lib/server/db/client";
import { replaceLegacyGrantDocumentFields } from "./replaceLegacyGrantDocumentFields";

const grantId = "11111111-1111-4111-8111-111111111111";
let deleteCondition: SQL | null = null;
let insertedParserVersions: string[] = [];
let transactionCount = 0;

const tx = {
  delete: () => ({
    where: (condition: SQL) => {
      deleteCondition = condition;
      return {
        returning: async () => [{ id: "legacy-field" }],
      };
    },
  }),
  insert: () => ({
    values: async (fields: Array<{ parserVersion?: string }>) => {
      insertedParserVersions = fields.map((field) => field.parserVersion ?? "");
    },
  }),
};
const db = {
  transaction: async <T>(run: (session: typeof tx) => Promise<T>): Promise<T> => {
    transactionCount += 1;
    return run(tx);
  },
} as unknown as CunoteDb;

const result = await replaceLegacyGrantDocumentFields({
  db,
  grantId,
  fields: [{
    grantId,
    source: "kstartup",
    sourceId: "source-1",
    documentCategory: "application_form",
    documentName: "신청서",
    fieldKey: "company_name",
    label: "기업명",
    fieldType: "text",
    fillStrategy: "profile",
    confidence: 1,
    parserVersion: GRANT_DOCUMENT_FIELD_PARSER_VERSION,
  }],
});

assert.deepEqual(result, { deletedCount: 1, insertedCount: 1 });
assert.equal(transactionCount, 1, "legacy 삭제와 재삽입은 한 transaction이어야 한다");
assert.deepEqual(insertedParserVersions, [GRANT_DOCUMENT_FIELD_PARSER_VERSION]);
assert.ok(deleteCondition);
const rendered = new PgDialect().sqlToQuery(sql`select 1 where ${deleteCondition}`);
assert.match(rendered.sql, /"grant_document_fields"\."grant_id" = \$\d+/u);
assert.match(rendered.sql, /"grant_document_fields"\."parser_version" = \$\d+/u);
assert.deepEqual(
  rendered.params,
  [grantId, GRANT_DOCUMENT_FIELD_PARSER_VERSION],
  "삭제 범위는 해당 공고의 legacy parser 소유 행으로만 제한해야 한다",
);

console.log("legacy grant document field replacement tests: ok");

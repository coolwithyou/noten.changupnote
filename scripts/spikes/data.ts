// P0-2용 읽기 전용 데이터 접근: archive markdown 보유 실공고 조회 + R2에서 markdown 원문 로드.
// select만 수행하며 어떤 쓰기(insert/update/DDL)도 하지 않는다.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { requireEnv } from "./env.ts";

export type GrantDoc = {
  grantId: string;
  title: string;
  source: string;
  sourceId: string;
  filename: string;
  markdownStorageKey: string;
  markdownBytes: number | null;
  applyEnd: string | null;
  supportAmount: unknown;
  requiredDocuments: unknown;
};

export async function findGrantsWithMarkdown(limit = 12): Promise<GrantDoc[]> {
  const sql = postgres(requireEnv("DATABASE_URL"), { prepare: false, max: 1 });
  try {
    // 실공고 marker: grant_application_surfaces 가 존재하는 grant 우선.
    // markdown 원문: grant_attachment_archives.markdown_storage_key (R2).
    const rows = await sql<GrantDoc[]>`
      SELECT DISTINCT ON (g.id)
        g.id AS "grantId",
        g.title AS "title",
        a.source AS "source",
        a.source_id AS "sourceId",
        a.filename AS "filename",
        a.markdown_storage_key AS "markdownStorageKey",
        a.markdown_bytes AS "markdownBytes",
        g.apply_end AS "applyEnd",
        g.support_amount AS "supportAmount",
        g.required_documents AS "requiredDocuments"
      FROM grant_attachment_archives a
      JOIN grants g ON g.source = a.source AND g.source_id = a.source_id
      WHERE a.markdown_storage_key IS NOT NULL
        AND a.markdown_bytes IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM grant_application_surfaces s WHERE s.grant_id = g.id
        )
      ORDER BY g.id, a.markdown_bytes DESC
      LIMIT ${limit}
    `;
    return rows;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

let r2: S3Client | null = null;
function getR2(): { client: S3Client; bucket: string } {
  const bucket = requireEnv("R2_BUCKET");
  if (!r2) {
    const accountId = requireEnv("R2_ACCOUNT_ID");
    const endpoint = (process.env.R2_ENDPOINT?.trim() ||
      `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
    r2 = new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return { client: r2, bucket };
}

export async function fetchMarkdown(key: string): Promise<string> {
  const { client, bucket } = getR2();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) return "";
  return res.Body.transformToString();
}

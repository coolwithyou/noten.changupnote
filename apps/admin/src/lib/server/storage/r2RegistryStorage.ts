import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface RegistryStorage {
  getBytes(key: string): Promise<{ body: Buffer; contentType: string | null }>;
  presignPut(input: { key: string; contentType: string; expiresIn?: number }): Promise<string>;
}

export function createRegistryStorageFromEnv(env: NodeJS.ProcessEnv = process.env): RegistryStorage | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const endpoint = (env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
  const client = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async getBytes(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) return { body: Buffer.alloc(0), contentType: result.ContentType ?? null };
      return {
        body: Buffer.from(await result.Body.transformToByteArray()),
        contentType: result.ContentType ?? null,
      };
    },
    async presignPut(input) {
      return getSignedUrl(
        client as unknown as Parameters<typeof getSignedUrl>[0],
        new PutObjectCommand({ Bucket: bucket, Key: input.key, ContentType: input.contentType }),
        { expiresIn: input.expiresIn ?? 900 },
      );
    },
  };
}

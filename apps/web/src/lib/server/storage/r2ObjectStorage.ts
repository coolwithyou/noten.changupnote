import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface R2ObjectStorage {
  putObject(input: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<{ key: string; url: string }>;
  publicUrl(key: string): string;
}

interface R2ObjectStorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  endpoint?: string;
}

export function createR2ObjectStorageFromEnv(env: NodeJS.ProcessEnv = process.env): R2ObjectStorage | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const publicBaseUrl = env.R2_BUCKET_URL?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null;
  return createR2ObjectStorage({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl,
    ...(env.R2_ENDPOINT?.trim() ? { endpoint: env.R2_ENDPOINT.trim() } : {}),
  });
}

export function createR2ObjectStorage(config: R2ObjectStorageConfig): R2ObjectStorage {
  const endpoint = (config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  const client = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async putObject(input) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }));
      return {
        key: input.key,
        url: `${publicBaseUrl}/${encodeObjectKey(input.key)}`,
      };
    },
    publicUrl(key) {
      return `${publicBaseUrl}/${encodeObjectKey(key)}`;
    },
  };
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

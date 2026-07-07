import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface R2ObjectStorage {
  getObjectText(key: string): Promise<string>;
  getObjectBytes(key: string): Promise<{ body: Buffer; contentType: string | null }>;
  objectExists(key: string): Promise<boolean>;
  putObject(input: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<{ key: string; url: string }>;
  publicUrl(key: string): string;
  /**
   * presigned GET URL. 버킷이 비공개라 외부 소비자(변환 서버 등)가 다운로드하려면 필요하다.
   * (archive_url/publicUrl 의 S3 엔드포인트 URL 은 SigV4 없이 400 — 2026-07-08 실측.)
   */
  presignGetUrl(key: string, expiresInSeconds?: number): Promise<string>;
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
    async getObjectText(key) {
      const result = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
      if (!result.Body) return "";
      return result.Body.transformToString();
    },
    async getObjectBytes(key) {
      const result = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
      const contentType = result.ContentType ?? null;
      if (!result.Body) return { body: Buffer.alloc(0), contentType };
      const bytes = await result.Body.transformToByteArray();
      return { body: Buffer.from(bytes), contentType };
    },
    async objectExists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        const name = (error as { name?: string }).name;
        if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
        throw error;
      }
    },
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
    async presignGetUrl(key, expiresInSeconds = 7200) {
      // exactOptionalPropertyTypes 아래에서 S3Client 와 presigner 의 Client 제네릭이 어긋나
      // 대입이 거부된다(런타임은 동일 객체) — 시그니처 타입으로 좁혀서 전달한다.
      return getSignedUrl(
        client as unknown as Parameters<typeof getSignedUrl>[0],
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

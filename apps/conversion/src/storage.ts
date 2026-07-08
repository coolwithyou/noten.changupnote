// T4: 변환 산출물 R2 업로드 + storage key 규칙 (계획 7장).
// convertDocument 결과(pdf / page images / markdown)를 R2에 putObject 하고
// document_artifacts 로 upsert 할 수 있는 artifact 목록을 반환한다.
//
// R2 클라이언트는 apps/web 의 R2ObjectStorage 패턴을 재사용한다 (@aws-sdk/client-s3).
// 키 규칙: grant-convert/<source>/<sourceId>/<kind>/<원본sha256[0:16]>-<sanitizedName>
//   pdf         : grant-convert/bizinfo/PBLN.../pdf/<sha16>-<name>.pdf
//   page_image  : grant-convert/bizinfo/PBLN.../page_image/<sha16>-<name>-p001.png
//   markdown    : grant-convert/bizinfo/PBLN.../markdown/<sha16>-<name>.md

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ConvertDocumentResult } from "./types.js";

/** artifact kind (document_artifacts.kind 와 정합). */
export type ArtifactKind = "pdf" | "page_image" | "markdown" | "hwpx";

/** R2에 업로드된 artifact 1건. GET /:jobId/artifacts 응답의 원소이자 document_artifacts 행 1개. */
export interface UploadedArtifact {
  kind: ArtifactKind;
  /** page_image 인 경우 1-based 페이지 번호. 그 외 null. */
  page: number | null;
  storageKey: string;
  url: string;
  /** artifact 자체(업로드된 바이트)의 sha256. 무결성/dedup 용. */
  sha256: string;
  contentType: string;
  bytes: number;
  /** kind별 메타데이터 (document_artifacts.metadata jsonb). */
  metadata: Record<string, unknown>;
}

/** 최소 R2 클라이언트 인터페이스 (apps/web R2ObjectStorage 와 동형). */
export interface R2ObjectStorage {
  putObject(input: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<{ key: string; url: string }>;
  getObjectText(key: string): Promise<string>;
  publicUrl(key: string): string;
}

export interface R2ObjectStorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  endpoint?: string;
  /** 키 프리픽스 override (검증용 conversion-dev/ 등). 기본 없음(grant-convert). */
  keyPrefix?: string;
}

/** 환경변수에서 R2 클라이언트 생성. 자격증명 누락 시 null. */
export function createR2ObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): R2ObjectStorage | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const publicBaseUrl = env.R2_BUCKET_URL?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) {
    return null;
  }
  return createR2ObjectStorage({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl,
    ...(env.R2_ENDPOINT?.trim() ? { endpoint: env.R2_ENDPOINT.trim() } : {}),
  });
}

/** R2ObjectStorage 인스턴스 생성 (apps/web 패턴 재사용). */
export function createR2ObjectStorage(config: R2ObjectStorageConfig): R2ObjectStorage {
  const endpoint = (
    config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, "");
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
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
      return { key: input.key, url: `${publicBaseUrl}/${encodeObjectKey(input.key)}` };
    },
    async getObjectText(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (!result.Body) return "";
      return result.Body.transformToString();
    },
    publicUrl(key) {
      return `${publicBaseUrl}/${encodeObjectKey(key)}`;
    },
  };
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** grantAttachmentArchive.sanitizeKeyPart 규칙과 정합. */
export function sanitizeKeyPart(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[^\w .()[\]{}가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 180) || "item"
  );
}

function stripExtension(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

/**
 * storage key 생성 (계획 7장).
 * sha256 은 **원본 파일**의 sha256 (변환 결과가 아니라 입력). 같은 원본 = 같은 프리픽스.
 * keyPrefix 미지정 시 "grant-convert". 검증용으로 "conversion-dev" 등 override 가능.
 */
export function buildStorageKey(input: {
  source: string;
  sourceId: string;
  filename: string;
  sourceSha256: string;
  kind: ArtifactKind;
  /** page_image 인 경우 1-based 페이지 번호. */
  page?: number;
  keyPrefix?: string;
}): string {
  const sha16 = input.sourceSha256.slice(0, 16);
  const stem = sanitizeKeyPart(stripExtension(basename(input.filename)));
  const ext =
    input.kind === "pdf"
      ? "pdf"
      : input.kind === "markdown"
        ? "md"
        : input.kind === "hwpx"
          ? "hwpx"
          : "png";
  const name =
    input.kind === "page_image" && input.page !== undefined
      ? `${sha16}-${stem}-p${String(input.page).padStart(3, "0")}.${ext}`
      : `${sha16}-${stem}.${ext}`;
  return [
    input.keyPrefix ?? "grant-convert",
    sanitizeKeyPart(input.source),
    sanitizeKeyPart(input.sourceId),
    input.kind,
    name,
  ].join("/");
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CONTENT_TYPE: Record<ArtifactKind, string> = {
  pdf: "application/pdf",
  page_image: "image/png",
  markdown: "text/markdown; charset=utf-8",
  // apps/web 다운로드 라우트/첨부 처리와 정합(application/hwp+zip).
  hwpx: "application/hwp+zip",
};

export interface UploadArtifactsInput {
  storage: R2ObjectStorage;
  result: ConvertDocumentResult;
  source: string;
  sourceId: string;
  filename: string;
  /** 원본 파일 sha256. 미지정 시 result.sha256 사용. */
  sourceSha256?: string;
  /** 키 프리픽스 override (검증용 conversion-dev). */
  keyPrefix?: string;
}

/**
 * 변환 산출물을 R2 에 업로드하고 artifact 목록을 반환한다 (계획 4.3 / 5장 6단계).
 * - pdf / page_image[] / markdown 을 각각 putObject.
 * - storage key 프리픽스는 원본 sha256 앞 16자 (같은 원본 = 캐시 재사용).
 * - artifact.sha256 은 업로드된 바이트 자체의 sha256 (무결성/dedup).
 * - 부분 성공: result 에 있는 artifact 만 업로드한다 (pdf 없으면 빈 목록).
 */
export async function uploadArtifacts(
  input: UploadArtifactsInput,
): Promise<UploadedArtifact[]> {
  const sourceSha256 = input.sourceSha256 ?? input.result.sha256;
  const artifacts: UploadedArtifact[] = [];
  const keyPrefix = input.keyPrefix;

  // pdf
  if (input.result.pdf) {
    const body = readFileSync(input.result.pdf.path);
    const key = buildStorageKey({
      source: input.source,
      sourceId: input.sourceId,
      filename: input.filename,
      sourceSha256,
      kind: "pdf",
      ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    });
    const up = await input.storage.putObject({
      key,
      body,
      contentType: CONTENT_TYPE.pdf,
    });
    artifacts.push({
      kind: "pdf",
      page: null,
      storageKey: up.key,
      url: up.url,
      sha256: sha256Hex(body),
      contentType: CONTENT_TYPE.pdf,
      bytes: body.length,
      metadata: {
        pageCount: input.result.pdf.pageCount,
        renderEngine: input.result.pdf.renderEngine,
      },
    });
  }

  // page images
  for (const img of input.result.pageImages) {
    const body = readFileSync(img.path);
    const key = buildStorageKey({
      source: input.source,
      sourceId: input.sourceId,
      filename: input.filename,
      sourceSha256,
      kind: "page_image",
      page: img.page,
      ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    });
    const up = await input.storage.putObject({
      key,
      body,
      contentType: CONTENT_TYPE.page_image,
    });
    artifacts.push({
      kind: "page_image",
      page: img.page,
      storageKey: up.key,
      url: up.url,
      sha256: sha256Hex(body),
      contentType: CONTENT_TYPE.page_image,
      bytes: body.length,
      metadata: { width: img.width, height: img.height, dpi: img.dpi },
    });
  }

  // markdown
  if (input.result.markdown) {
    const body = Buffer.from(input.result.markdown.text, "utf8");
    const key = buildStorageKey({
      source: input.source,
      sourceId: input.sourceId,
      filename: input.filename,
      sourceSha256,
      kind: "markdown",
      ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    });
    const up = await input.storage.putObject({
      key,
      body,
      contentType: CONTENT_TYPE.markdown,
    });
    artifacts.push({
      kind: "markdown",
      page: null,
      storageKey: up.key,
      url: up.url,
      sha256: sha256Hex(body),
      contentType: CONTENT_TYPE.markdown,
      bytes: body.length,
      metadata: {
        charCount: input.result.markdown.charCount,
        converter: input.result.markdown.converter,
      },
    });
  }

  // hwpx (hwp2hwpx 트랙 Phase 1) — hwp 바이너리 변환·STORE 재포장 정규화 산출.
  if (input.result.hwpx) {
    const body = readFileSync(input.result.hwpx.path);
    const key = buildStorageKey({
      source: input.source,
      sourceId: input.sourceId,
      filename: input.filename,
      sourceSha256,
      kind: "hwpx",
      ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    });
    const up = await input.storage.putObject({
      key,
      body,
      contentType: CONTENT_TYPE.hwpx,
    });
    artifacts.push({
      kind: "hwpx",
      page: null,
      storageKey: up.key,
      url: up.url,
      sha256: sha256Hex(body),
      contentType: CONTENT_TYPE.hwpx,
      bytes: body.length,
      metadata: {
        converter: "hwp2hwpx",
        converterVersion: input.result.converterVersion,
        ...(input.result.hwpxConversion
          ? { outcome: input.result.hwpxConversion.outcome }
          : {}),
      },
    });
  }

  return artifacts;
}

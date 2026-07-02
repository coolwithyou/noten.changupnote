// T5: 내부 순차 큐 + 워커 풀 (계획 2장 처리 모델, 5장 파이프라인).
// - in-process 동시성 제한(기본 2)을 둔 워커 풀.
// - job 상태는 인메모리 저장 (Map). 인스턴스 재시작 시 유실 — 아카이브 재조정 스윕이 회복(계획 2장).
// - soffice 프로세스는 문서 1건당 convertDocument 내부에서 새로 띄우고 종료 (프로세스 격리).
// - POST 는 job 을 큐에 넣고 즉시 queued 로 응답, GET 으로 폴링.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDocument, type HwpToMarkdownFn } from "./convert-document.js";
import type { R2ObjectStorage, UploadedArtifact } from "./storage.js";
import { uploadArtifacts } from "./storage.js";
import {
  CONVERTER_VERSION,
  type ConvertDocumentResult,
  type Phase2ConversionQuality,
} from "./types.js";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed";

/** POST /v1/conversion-jobs 요청 본문 (계획 4.1). */
export interface ConversionJobRequest {
  jobId: string;
  source: string;
  sourceId: string;
  surfaceId?: string;
  filename: string;
  sourceObjectUrl: string;
  sha256: string;
  requestedArtifacts?: string[];
  options?: { pageImageDpi?: 220 | 300 };
}

/** 인메모리 job 레코드. */
export interface JobRecord {
  jobId: string;
  status: JobStatus;
  request: ConversionJobRequest;
  converterVersion: string;
  quality: Phase2ConversionQuality | null;
  artifacts: UploadedArtifact[];
  /** 원본 파일 sha256 (다운로드 후 재계산). 캐시 키의 일부. */
  sourceSha256: string | null;
  cached: boolean;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 다운로드 함수 주입 (테스트에서 로컬 파일로 대체 가능). */
export type FetchSourceFn = (url: string) => Promise<Buffer>;

export interface QueueConfig {
  storage: R2ObjectStorage;
  /** 동시성 (기본 2). */
  concurrency?: number;
  /** HWP→markdown 변환 함수 주입 (미주입 시 PDF fallback). */
  hwpToMarkdown?: HwpToMarkdownFn;
  /** 원본 다운로드 함수 (기본: global fetch). */
  fetchSource?: FetchSourceFn;
  /** R2 storage key 프리픽스 override (검증용 conversion-dev). */
  keyPrefix?: string;
  /** page image DPI 기본값. */
  defaultDpi?: 220 | 300;
}

/** 기본 다운로드: global fetch 로 sourceObjectUrl 을 내려받는다. */
async function defaultFetchSource(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`source download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * 캐시 키: 원본 sha256 + converterVersion.
 * 계획 7장/11장: 같은 원본 + 같은 converter 는 재변환하지 않는다.
 */
export function cacheKey(sha256: string, converterVersion: string): string {
  return `${sha256}:${converterVersion}`;
}

/** 인메모리 큐 + 워커 풀. */
export class ConversionQueue {
  private readonly storage: R2ObjectStorage;
  private readonly concurrency: number;
  private readonly hwpToMarkdown: HwpToMarkdownFn | undefined;
  private readonly fetchSource: FetchSourceFn;
  private readonly keyPrefix: string | undefined;
  private readonly defaultDpi: 220 | 300;

  private readonly jobs = new Map<string, JobRecord>();
  /** cacheKey -> 완료된 job 결과 (succeeded/partial). 캐시 히트 판정용. */
  private readonly cache = new Map<
    string,
    { status: JobStatus; artifacts: UploadedArtifact[]; quality: Phase2ConversionQuality | null }
  >();
  private readonly pending: string[] = [];
  private activeCount = 0;
  /** 관측용 카운터 (검증에서 동시성 확인). */
  peakActive = 0;

  constructor(config: QueueConfig) {
    this.storage = config.storage;
    this.concurrency = config.concurrency ?? 2;
    this.hwpToMarkdown = config.hwpToMarkdown;
    this.fetchSource = config.fetchSource ?? defaultFetchSource;
    this.keyPrefix = config.keyPrefix;
    this.defaultDpi = config.defaultDpi ?? 220;
  }

  /** 등록된 job 조회. */
  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /** 활성 워커 수 (관측용). */
  get active(): number {
    return this.activeCount;
  }

  /**
   * job 등록. 캐시 히트(같은 sha256 + converterVersion 결과 존재)면 즉시 succeeded/partial 로
   * 등록하고 cached=true 로 반환. 아니면 queued 로 넣고 워커를 깨운다.
   */
  enqueue(request: ConversionJobRequest): JobRecord {
    // 이미 같은 jobId 가 있으면 그대로 반환 (멱등).
    const existing = this.jobs.get(request.jobId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const key = cacheKey(request.sha256, CONVERTER_VERSION);
    const hit = this.cache.get(key);

    if (hit) {
      const record: JobRecord = {
        jobId: request.jobId,
        status: hit.status,
        request,
        converterVersion: CONVERTER_VERSION,
        quality: hit.quality,
        artifacts: hit.artifacts,
        sourceSha256: request.sha256,
        cached: true,
        error: null,
        queuedAt: now,
        startedAt: now,
        finishedAt: now,
      };
      this.jobs.set(request.jobId, record);
      return record;
    }

    const record: JobRecord = {
      jobId: request.jobId,
      status: "queued",
      request,
      converterVersion: CONVERTER_VERSION,
      quality: null,
      artifacts: [],
      sourceSha256: null,
      cached: false,
      error: null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(request.jobId, record);
    this.pending.push(request.jobId);
    this.pump();
    return record;
  }

  /** 큐가 빌 때까지 대기 (검증용). */
  async drain(): Promise<void> {
    while (this.pending.length > 0 || this.activeCount > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** 동시성 한도 내에서 대기 job 을 워커로 배정. */
  private pump(): void {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (jobId === undefined) break;
      const record = this.jobs.get(jobId);
      if (!record || record.status !== "queued") continue;
      this.activeCount += 1;
      this.peakActive = Math.max(this.peakActive, this.activeCount);
      // fire-and-forget; 완료 시 activeCount 감소 후 pump 재호출.
      void this.runJob(record).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  /** 워커 1건 처리: 다운로드 → 변환 → 업로드 → 상태 기록. */
  private async runJob(record: JobRecord): Promise<void> {
    record.status = "running";
    record.startedAt = new Date().toISOString();
    const workDir = mkdtempSync(join(tmpdir(), "cunote-job."));

    try {
      const body = await this.fetchSource(record.request.sourceObjectUrl);

      const result: ConvertDocumentResult = convertDocument(
        {
          body,
          filename: record.request.filename,
          expectedSha256: record.request.sha256,
          pageImageDpi: record.request.options?.pageImageDpi ?? this.defaultDpi,
          workDir,
        },
        this.hwpToMarkdown ? { hwpToMarkdown: this.hwpToMarkdown } : {},
      );

      record.sourceSha256 = result.sha256;
      record.quality = result.quality;

      if (result.jobStatus === "failed") {
        record.status = "failed";
        record.error = result.error;
        record.finishedAt = new Date().toISOString();
        return;
      }

      // 업로드 (부분 성공이면 있는 artifact 만 올라간다).
      const artifacts = await uploadArtifacts({
        storage: this.storage,
        result,
        source: record.request.source,
        sourceId: record.request.sourceId,
        filename: record.request.filename,
        sourceSha256: result.sha256,
        ...(this.keyPrefix !== undefined ? { keyPrefix: this.keyPrefix } : {}),
      });

      record.artifacts = artifacts;
      record.status = result.jobStatus; // succeeded | partial
      record.finishedAt = new Date().toISOString();

      // 캐시에 적재 (원본 sha256 + converterVersion).
      this.cache.set(cacheKey(result.sha256, CONVERTER_VERSION), {
        status: record.status,
        artifacts,
        quality: record.quality,
      });
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      record.finishedAt = new Date().toISOString();
    }
  }
}

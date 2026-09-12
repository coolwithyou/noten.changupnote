/**
 * 필드 후보 저장 계층 (Phase 4 [F3] · 마스터 설계 §8.4).
 *
 * CandidateSet(한 엔진/파서의 후보 묶음)을 R2 JSON + document_artifacts 행으로 저장/로드한다.
 *
 *   - R2 키: `grant-convert/<source>/<sourceId>/field_candidates/<sha16>-<engine>.json`
 *     (sha16 = 직렬화 JSON 의 sha256 앞 16자 — seed/conversion 키 관례와 동일한 shortHash).
 *   - document_artifacts: kind=`field_candidates`, metadata `{engine, engineVersion, layer,
 *     candidateCount, extractedAt}`.
 *   - 멱등: 일반 엔진은 (surfaceId, kind, metadata.engine), 선분석은 여기에
 *     analysisVersion + sourceSha256을 더한 identity 기준 앱측 upsert
 *     (document_artifacts 에 metadata 유니크 인덱스가 없어 select→update/insert; 관례는
 *     surfaceConversion.upsertDocumentArtifacts 와 동일).
 */
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { CandidateSet } from "@cunote/core";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";

export const FIELD_CANDIDATES_ARTIFACT_KIND = "field_candidates";

export interface SaveFieldCandidatesResult {
  storageKey: string;
  url: string | null;
  artifactId: string;
  engine: string;
  candidateCount: number;
  sha256: string;
  created: boolean;
}

export interface StagedFieldCandidates {
  surfaceId: string;
  storageKey: string;
  url: string | null;
  engine: string;
  candidateCount: number;
  sha256: string;
  metadata: Record<string, unknown>;
}

export interface FieldCandidateStore {
  /** CandidateSet 을 R2 + document_artifacts 로 저장한다 (엔진 단위 멱등). */
  saveFieldCandidates(input: {
    surfaceId: string;
    set: CandidateSet;
    /** engine 공통 메타 외의 분석 identity·상태. 정본 필드는 아래에서 덮어쓴다. */
    metadata?: Record<string, unknown>;
  }): Promise<SaveFieldCandidatesResult>;
  /** surface 의 모든 field_candidates 를 R2 에서 읽어 CandidateSet[] 로 반환한다. */
  loadFieldCandidates(surfaceId: string): Promise<CandidateSet[]>;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** 파일명 안전화 (엔진 식별자). */
function fileSafe(value: string): string {
  const s = value.toLowerCase().replace(/[^0-9a-z._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return s || "engine";
}

export function fieldCandidatesStorageKey(input: {
  source: string;
  sourceId: string;
  set: CandidateSet;
}): string {
  const body = JSON.stringify(input.set);
  return `grant-convert/${input.source}/${input.sourceId}/field_candidates/${shortHash(body)}-${fileSafe(input.set.engine)}.json`;
}

export function createFieldCandidateStore(deps: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
}): FieldCandidateStore {
  const { db, storage } = deps;

  return {
    async saveFieldCandidates({ surfaceId, set, metadata: extraMetadata }) {
      const staged = await stageFieldCandidates({
        db,
        storage,
        surfaceId,
        set,
        ...(extraMetadata ? { metadata: extraMetadata } : {}),
      });
      return persistStagedFieldCandidates({ db, staged });
    },

    async loadFieldCandidates(surfaceId) {
      const rows = await db
        .select({ storageKey: schema.documentArtifacts.storageKey })
        .from(schema.documentArtifacts)
        .where(
          and(
            eq(schema.documentArtifacts.surfaceId, surfaceId),
            eq(schema.documentArtifacts.kind, FIELD_CANDIDATES_ARTIFACT_KIND),
          ),
        )
        .orderBy(asc(schema.documentArtifacts.createdAt));

      const sets: CandidateSet[] = [];
      for (const row of rows) {
        const text = await storage.getObjectText(row.storageKey);
        if (!text) continue;
        sets.push(JSON.parse(text) as CandidateSet);
      }
      return sets;
    },
  };
}

/** content-addressed R2 object만 먼저 둔다. DB artifact pointer는 쓰지 않는다. */
export async function stageFieldCandidates(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  surfaceId: string;
  set: CandidateSet;
  metadata?: Record<string, unknown>;
}): Promise<StagedFieldCandidates> {
  const [ref] = await input.db.select({
    source: schema.grantApplicationSurfaces.source,
    sourceId: schema.grantApplicationSurfaces.sourceId,
  }).from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, input.surfaceId)).limit(1);
  if (!ref) throw new Error(`surface 를 찾을 수 없습니다: ${input.surfaceId}`);
  const body = JSON.stringify(input.set);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const storageKey = fieldCandidatesStorageKey({ source: ref.source, sourceId: ref.sourceId, set: input.set });
  const put = await input.storage.putObject({ key: storageKey, body, contentType: "application/json" });
  return {
    surfaceId: input.surfaceId,
    storageKey,
    url: put.url,
    engine: input.set.engine,
    candidateCount: input.set.candidates.length,
    sha256,
    metadata: {
      ...input.metadata,
      engine: input.set.engine,
      engineVersion: input.set.engineVersion,
      layer: input.set.layer,
      candidateCount: input.set.candidates.length,
      extractedAt: input.set.extractedAt,
    },
  };
}

/** 이미 staged된 immutable object의 DB pointer만 현재 transaction에 기록한다. */
export async function persistStagedFieldCandidates(input: {
  db: CunoteDbSession;
  staged: StagedFieldCandidates;
}): Promise<SaveFieldCandidatesResult> {
  const { db, staged } = input;
  const analysisVersion = stringMetadata(staged.metadata.analysisVersion);
  const sourceSha256 = stringMetadata(staged.metadata.sourceSha256);
  const existing = await db.select({ id: schema.documentArtifacts.id, metadata: schema.documentArtifacts.metadata })
    .from(schema.documentArtifacts)
    .where(and(
      eq(schema.documentArtifacts.surfaceId, staged.surfaceId),
      eq(schema.documentArtifacts.kind, FIELD_CANDIDATES_ARTIFACT_KIND),
    ));
  const match = existing.find((row) => {
    const metadata = row.metadata as Record<string, unknown> | null;
    if (metadata?.engine !== staged.engine) return false;
    if (!analysisVersion || !sourceSha256) return true;
    return metadata.analysisVersion === analysisVersion && metadata.sourceSha256 === sourceSha256;
  });
  const values = {
    kind: FIELD_CANDIDATES_ARTIFACT_KIND,
    page: null,
    storageKey: staged.storageKey,
    url: staged.url,
    contentType: "application/json",
    sha256: staged.sha256,
    metadata: staged.metadata,
  };
  if (match) {
    await db.update(schema.documentArtifacts).set(values)
      .where(eq(schema.documentArtifacts.id, match.id));
    return {
      storageKey: staged.storageKey,
      url: staged.url,
      artifactId: match.id,
      engine: staged.engine,
      candidateCount: staged.candidateCount,
      sha256: staged.sha256,
      created: false,
    };
  }
  const [inserted] = await db.insert(schema.documentArtifacts)
    .values({ surfaceId: staged.surfaceId, ...values })
    .returning({ id: schema.documentArtifacts.id });
  if (!inserted) throw new Error("field candidate artifact pointer 생성에 실패했습니다.");
  return {
    storageKey: staged.storageKey,
    url: staged.url,
    artifactId: inserted.id,
    engine: staged.engine,
    candidateCount: staged.candidateCount,
    sha256: staged.sha256,
    created: true,
  };
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

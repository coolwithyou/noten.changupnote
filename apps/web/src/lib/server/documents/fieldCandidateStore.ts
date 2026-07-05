/**
 * 필드 후보 저장 계층 (Phase 4 [F3] · 마스터 설계 §8.4).
 *
 * CandidateSet(한 엔진/파서의 후보 묶음)을 R2 JSON + document_artifacts 행으로 저장/로드한다.
 *
 *   - R2 키: `grant-convert/<source>/<sourceId>/field_candidates/<sha16>-<engine>.json`
 *     (sha16 = 직렬화 JSON 의 sha256 앞 16자 — seed/conversion 키 관례와 동일한 shortHash).
 *   - document_artifacts: kind=`field_candidates`, metadata `{engine, engineVersion, layer,
 *     candidateCount, extractedAt}`.
 *   - 멱등: (surfaceId, kind, metadata.engine) 기준 앱측 upsert
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
  created: boolean;
}

export interface FieldCandidateStore {
  /** CandidateSet 을 R2 + document_artifacts 로 저장한다 (엔진 단위 멱등). */
  saveFieldCandidates(input: { surfaceId: string; set: CandidateSet }): Promise<SaveFieldCandidatesResult>;
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

interface SurfaceRef {
  source: string;
  sourceId: string;
}

export function createFieldCandidateStore(deps: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
}): FieldCandidateStore {
  const { db, storage } = deps;

  async function surfaceRef(surfaceId: string): Promise<SurfaceRef> {
    const rows = await db
      .select({
        source: schema.grantApplicationSurfaces.source,
        sourceId: schema.grantApplicationSurfaces.sourceId,
      })
      .from(schema.grantApplicationSurfaces)
      .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`surface 를 찾을 수 없습니다: ${surfaceId}`);
    return { source: row.source, sourceId: row.sourceId };
  }

  return {
    async saveFieldCandidates({ surfaceId, set }) {
      const ref = await surfaceRef(surfaceId);
      const body = JSON.stringify(set);
      const sha16 = shortHash(body);
      const storageKey = `grant-convert/${ref.source}/${ref.sourceId}/field_candidates/${sha16}-${fileSafe(set.engine)}.json`;

      const put = await storage.putObject({ key: storageKey, body, contentType: "application/json" });

      const metadata: Record<string, unknown> = {
        engine: set.engine,
        engineVersion: set.engineVersion,
        layer: set.layer,
        candidateCount: set.candidates.length,
        extractedAt: set.extractedAt,
      };

      // 멱등: 같은 surface + kind + metadata.engine 이 있으면 update.
      const existing = await db
        .select({ id: schema.documentArtifacts.id, metadata: schema.documentArtifacts.metadata })
        .from(schema.documentArtifacts)
        .where(
          and(
            eq(schema.documentArtifacts.surfaceId, surfaceId),
            eq(schema.documentArtifacts.kind, FIELD_CANDIDATES_ARTIFACT_KIND),
          ),
        );
      const match = existing.find(
        (row) => (row.metadata as { engine?: unknown } | null)?.engine === set.engine,
      );

      const values = {
        kind: FIELD_CANDIDATES_ARTIFACT_KIND,
        page: null,
        storageKey,
        url: put.url,
        contentType: "application/json",
        sha256: createHash("sha256").update(body).digest("hex"),
        metadata,
      };

      if (match) {
        await db
          .update(schema.documentArtifacts)
          .set(values)
          .where(eq(schema.documentArtifacts.id, match.id));
        return {
          storageKey,
          url: put.url,
          artifactId: match.id,
          engine: set.engine,
          candidateCount: set.candidates.length,
          created: false,
        };
      }

      const inserted = await db
        .insert(schema.documentArtifacts)
        .values({ surfaceId, ...values })
        .returning({ id: schema.documentArtifacts.id });
      return {
        storageKey,
        url: put.url,
        artifactId: inserted[0]!.id,
        engine: set.engine,
        candidateCount: set.candidates.length,
        created: true,
      };
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

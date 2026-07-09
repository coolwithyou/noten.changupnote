import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Grant, MatchCard } from "@cunote/contracts";
import { isFormLikeFilename } from "@cunote/core";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { HWPX_SIBLING_ARTIFACT_KIND } from "../documents/draftHwpxExport";

/**
 * 매칭 카드의 writeSupport 를 ai_draft → template_fill 로 승격한다.
 * core 는 순수 조립부라 보관본을 모르므로(마스터 설계의 hwpxTemplateAvailable 원칙과 동일),
 * 서버 레이어가 HWPX 보관본·hwp2hwpx sibling 변환본을 소스별 배치 2쿼리로 조회해 덮어쓴다.
 * DB 미가용(샘플 데이터 모드 등)이나 조회 실패 시 승격 없이 원본 카드를 그대로 반환한다 — 과약속 방지.
 */
export async function annotateMatchCardWriteSupport(matches: MatchCard[]): Promise<MatchCard[]> {
  const candidates = matches.filter((match) => match.writeSupport === "ai_draft");
  if (candidates.length === 0) return matches;

  let fillableKeys: Set<string>;
  try {
    fillableKeys = await loadHwpxFillableGrantKeys(candidates);
  } catch (error) {
    console.warn(
      `writeSupport 승격 조회 실패(승격 없이 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
    return matches;
  }
  if (fillableKeys.size === 0) return matches;

  return matches.map((match) =>
    match.writeSupport === "ai_draft" && fillableKeys.has(grantSourceKey(match))
      ? { ...match, writeSupport: "template_fill" as const }
      : match,
  );
}

async function loadHwpxFillableGrantKeys(candidates: MatchCard[]): Promise<Set<string>> {
  const sourceIdsBySource = new Map<Grant["source"], Set<string>>();
  for (const match of candidates) {
    const ids = sourceIdsBySource.get(match.source) ?? new Set<string>();
    ids.add(match.sourceId);
    sourceIdsBySource.set(match.source, ids);
  }

  const db = getCunoteDb();
  const keys = new Set<string>();

  for (const [source, ids] of sourceIdsBySource) {
    const sourceIds = [...ids];

    // 1) R2 보관본에 서식성 .hwpx 가 있는 공고 (draftHwpxExport 의 판정과 동일: storageKey 필수)
    const archiveRows = await db
      .select({
        sourceId: schema.grantAttachmentArchives.sourceId,
        filename: schema.grantAttachmentArchives.filename,
      })
      .from(schema.grantAttachmentArchives)
      .where(
        and(
          eq(schema.grantAttachmentArchives.source, source),
          inArray(schema.grantAttachmentArchives.sourceId, sourceIds),
          isNotNull(schema.grantAttachmentArchives.storageKey),
        ),
      );
    for (const row of archiveRows) {
      if (row.filename.toLowerCase().endsWith(".hwpx") && isFormLikeFilename(row.filename)) {
        keys.add(`${source}:${row.sourceId}`);
      }
    }

    // 2) hwp2hwpx sibling 변환본이 있는 공고 (surface.title = 원본 첨부 파일명)
    const siblingRows = await db
      .select({
        sourceId: schema.grantApplicationSurfaces.sourceId,
        title: schema.grantApplicationSurfaces.title,
      })
      .from(schema.documentArtifacts)
      .innerJoin(
        schema.grantApplicationSurfaces,
        eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
      )
      .where(
        and(
          eq(schema.grantApplicationSurfaces.source, source),
          inArray(schema.grantApplicationSurfaces.sourceId, sourceIds),
          eq(schema.documentArtifacts.kind, HWPX_SIBLING_ARTIFACT_KIND),
        ),
      );
    for (const row of siblingRows) {
      if (isFormLikeFilename(row.title)) keys.add(`${source}:${row.sourceId}`);
    }
  }

  return keys;
}

function grantSourceKey(match: MatchCard): string {
  return `${match.source}:${match.sourceId}`;
}

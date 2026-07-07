/**
 * 검수 큐 유입기 — 실공고 변환 결과(surface)를 필드맵 검수 큐에 등재한다 (슬라이스 B1).
 *
 * 정본: docs/plans/2026-07-08-ideal-flow-vertical-slice.md "슬라이스 B — B1. 검수 큐 유입기".
 *
 * 기존 spike 임포터(import-review-docs.ts)는 spike-labels/*.json 45문서 전용이다. 이 유입기는
 * 변환 파이프라인이 만든 preview_ready surface(page_image artifact 보유)를 field_map_review_docs 로
 * 등재해, 신규 실공고가 검수 큐로 흐르게 한다.
 *
 * 대상 선정:
 *   - grant_application_surfaces.extraction_status='preview_ready'
 *   - page_image artifact ≥ 1 (뷰어/검수 GUI 가 보여줄 이미지가 있어야 함)
 *   - 아직 미등재 (docRef 'surface:<surfaceId>' 가 field_map_review_docs 에 없음 — docRef 유니크)
 *   - 대응 grant.status='open' 우선, 마감 임박(apply_end) 순
 *
 * docRef 규약: `surface:<surfaceId>` — 이 네임스페이스가 B3 승인 반영 브리지의 조건 키다.
 * docId 규약: `s-<surfaceId 앞 8자>` (GUI 라우팅 키). 충돌 시 자릿수를 늘려 유일화.
 * labelJson: spike 임포터와 동일 계약(GUI 소비). 초기 fields=[] (B2 사전라벨이 채움) + source 메타.
 * pageImageKeys: 해당 surface 의 page_image artifact storage_key 를 page 순으로 (R2 재사용, 재업로드 없음).
 *
 * 멱등: 재실행 시 이미 등재된 docRef 는 스킵(skipped 집계).
 * 기본은 dry-run. --write 를 붙여야 실제 DB 쓰기가 일어난다 (레포 CLI 관례).
 *
 * 사용:
 *   pnpm import:review-docs:from-surfaces                          # dry-run (limit 10)
 *   pnpm import:review-docs:from-surfaces -- --write               # 실제 등재
 *   pnpm import:review-docs:from-surfaces -- --limit=20 --write
 *   pnpm import:review-docs:from-surfaces -- --grantId=<uuid> --write
 *   pnpm import:review-docs:from-surfaces -- --surfaceId=<uuid> --write
 */
import { pathToFileURL } from "node:url";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { SURFACE_DOC_REF_PREFIX } from "../documents/reviewFieldMapping";

loadMonorepoEnv();

const DEFAULT_LIMIT = 10;
// docRef 네임스페이스 접두어(`surface:`)는 reviewFieldMapping 이 단일 원천 — 재노출만 한다(B2 import 경로 유지).
export { SURFACE_DOC_REF_PREFIX };

export interface ImportFromSurfacesOptions {
  db: CunoteDb;
  limit?: number;
  grantId?: string | null;
  surfaceId?: string | null;
  write?: boolean;
}

export interface SurfaceImportDecision {
  surfaceId: string;
  docRef: string;
  docId: string;
  grantId: string;
  grantStatus: string;
  pageImageCount: number;
  action: "insert" | "skip_registered" | "skip_no_pages";
}

export interface ImportFromSurfacesSummary {
  dryRun: boolean;
  totals: {
    candidates: number;
    inserted: number;
    skippedRegistered: number;
    skippedNoPages: number;
  };
  decisions: SurfaceImportDecision[];
}

interface SurfaceRow {
  surfaceId: string;
  grantId: string;
  grantStatus: string;
  grantSource: string;
  grantSourceId: string;
  grantTitle: string;
  grantUrl: string | null;
  applyEnd: Date | null;
  surfaceTitle: string;
  surfaceFormat: string;
  sourceAttachment: string | null;
  sourceUrl: string | null;
  createdAt: Date;
}

/**
 * preview_ready surface 를 검수 큐에 등재한다. R2 미접근(이미지 키만 참조) — db 만 필요.
 * verify 스크립트도 이 함수를 재사용한다(같은 등재 경로를 검증).
 */
export async function importReviewDocsFromSurfaces(
  options: ImportFromSurfacesOptions,
): Promise<ImportFromSurfacesSummary> {
  const { db } = options;
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const write = options.write ?? false;

  // 1) preview_ready surface + 대응 grant. (옵션 필터: grantId / surfaceId)
  const filters = [eq(schema.grantApplicationSurfaces.extractionStatus, "preview_ready")];
  if (options.grantId) filters.push(eq(schema.grantApplicationSurfaces.grantId, options.grantId));
  if (options.surfaceId) filters.push(eq(schema.grantApplicationSurfaces.id, options.surfaceId));

  const surfaceRows = (await db
    .select({
      surfaceId: schema.grantApplicationSurfaces.id,
      grantId: schema.grantApplicationSurfaces.grantId,
      grantStatus: schema.grants.status,
      grantSource: schema.grants.source,
      grantSourceId: schema.grants.sourceId,
      grantTitle: schema.grants.title,
      grantUrl: schema.grants.url,
      applyEnd: schema.grants.applyEnd,
      surfaceTitle: schema.grantApplicationSurfaces.title,
      surfaceFormat: schema.grantApplicationSurfaces.format,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      sourceUrl: schema.grantApplicationSurfaces.sourceUrl,
      createdAt: schema.grantApplicationSurfaces.createdAt,
    })
    .from(schema.grantApplicationSurfaces)
    .innerJoin(schema.grants, eq(schema.grantApplicationSurfaces.grantId, schema.grants.id))
    .where(and(...filters))) as SurfaceRow[];

  if (surfaceRows.length === 0) {
    return emptySummary(write);
  }

  const surfaceIds = surfaceRows.map((r) => r.surfaceId);

  // 2) page_image artifact 수 (surface 별).
  const artifactRows = await db
    .select({
      surfaceId: schema.documentArtifacts.surfaceId,
      page: schema.documentArtifacts.page,
      storageKey: schema.documentArtifacts.storageKey,
    })
    .from(schema.documentArtifacts)
    .where(
      and(
        inArray(schema.documentArtifacts.surfaceId, surfaceIds),
        eq(schema.documentArtifacts.kind, "page_image"),
      ),
    )
    .orderBy(asc(schema.documentArtifacts.surfaceId), asc(schema.documentArtifacts.page));

  const pageKeysBySurface = new Map<string, string[]>();
  for (const row of artifactRows) {
    const list = pageKeysBySurface.get(row.surfaceId) ?? [];
    list.push(row.storageKey);
    pageKeysBySurface.set(row.surfaceId, list);
  }

  // 3) 이미 등재된 surface docRef 집합.
  const registered = await db
    .select({ docRef: schema.fieldMapReviewDocs.docRef })
    .from(schema.fieldMapReviewDocs)
    .where(like(schema.fieldMapReviewDocs.docRef, `${SURFACE_DOC_REF_PREFIX}%`));
  const registeredRefs = new Set(registered.map((r) => r.docRef));

  // docId 충돌 방지: 기존 docId 전체 집합(수십~수백 규모).
  const existingDocIds = new Set(
    (await db.select({ docId: schema.fieldMapReviewDocs.docId }).from(schema.fieldMapReviewDocs)).map(
      (r) => r.docId,
    ),
  );

  // 4) 후보 필터 + 정렬 (open 우선 → 마감 임박 → 생성 순) + limit.
  const candidates = surfaceRows
    .filter((r) => (pageKeysBySurface.get(r.surfaceId)?.length ?? 0) >= 1)
    .filter((r) => !registeredRefs.has(`${SURFACE_DOC_REF_PREFIX}${r.surfaceId}`))
    .sort(compareCandidates);

  const decisions: SurfaceImportDecision[] = [];

  // 미등재이나 page_image 가 없는 surface 도 요약에 남긴다(진단용).
  const noPages = surfaceRows.filter(
    (r) =>
      (pageKeysBySurface.get(r.surfaceId)?.length ?? 0) === 0 &&
      !registeredRefs.has(`${SURFACE_DOC_REF_PREFIX}${r.surfaceId}`),
  );
  for (const r of noPages) {
    decisions.push({
      surfaceId: r.surfaceId,
      docRef: `${SURFACE_DOC_REF_PREFIX}${r.surfaceId}`,
      docId: "",
      grantId: r.grantId,
      grantStatus: r.grantStatus,
      pageImageCount: 0,
      action: "skip_no_pages",
    });
  }

  let inserted = 0;
  for (const row of candidates.slice(0, limit)) {
    const docRef = `${SURFACE_DOC_REF_PREFIX}${row.surfaceId}`;
    const pageImageKeys = pageKeysBySurface.get(row.surfaceId) ?? [];
    const docId = allocateDocId(row.surfaceId, existingDocIds);

    if (write) {
      await db.insert(schema.fieldMapReviewDocs).values({
        docRef,
        docId,
        sourceFilename: row.surfaceTitle,
        pageCount: pageImageKeys.length,
        labelJson: buildSurfaceLabelJson(row, pageImageKeys.length),
        // labeledBy=null: 아직 라벨 없음(빈 fields). B2 사전라벨이 ai:<model> 로 채운다.
        labeledBy: null,
        labeledAt: null,
        reviewStatus: "pending",
        correctionNotes: null,
        pageImageKeys,
      });
    }
    existingDocIds.add(docId);

    decisions.push({
      surfaceId: row.surfaceId,
      docRef,
      docId,
      grantId: row.grantId,
      grantStatus: row.grantStatus,
      pageImageCount: pageImageKeys.length,
      action: "insert",
    });
    inserted += 1;
  }

  return {
    dryRun: !write,
    totals: {
      candidates: candidates.length,
      inserted,
      skippedRegistered: registeredRefs.size,
      skippedNoPages: noPages.length,
    },
    decisions,
  };
}

/** open 공고 우선 → 마감 임박(apply_end asc, null 후순위) → 생성 순. */
function compareCandidates(a: SurfaceRow, b: SurfaceRow): number {
  const aOpen = a.grantStatus === "open" ? 0 : 1;
  const bOpen = b.grantStatus === "open" ? 0 : 1;
  if (aOpen !== bOpen) return aOpen - bOpen;
  const aEnd = a.applyEnd ? a.applyEnd.getTime() : Number.POSITIVE_INFINITY;
  const bEnd = b.applyEnd ? b.applyEnd.getTime() : Number.POSITIVE_INFINITY;
  if (aEnd !== bEnd) return aEnd - bEnd;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** labelJson: spike 임포터와 동일 계약 + source 링크 메타. 초기 fields=[]. */
function buildSurfaceLabelJson(row: SurfaceRow, pageCount: number): Record<string, unknown> {
  return {
    docRef: `${SURFACE_DOC_REF_PREFIX}${row.surfaceId}`,
    labeledBy: null,
    labeledAt: null,
    pageCount,
    fields: [],
    // source: 검수자·B2·B3 가 원 공고/문서를 되짚는 링크 정보.
    source: {
      kind: "surface",
      surfaceId: row.surfaceId,
      grantId: row.grantId,
      grantSource: row.grantSource,
      grantSourceId: row.grantSourceId,
      grantTitle: row.grantTitle,
      grantUrl: row.grantUrl,
      surfaceTitle: row.surfaceTitle,
      surfaceFormat: row.surfaceFormat,
      sourceAttachment: row.sourceAttachment,
      sourceUrl: row.sourceUrl,
    },
    sourceFilename: row.surfaceTitle,
  };
}

/** `s-<앞8자>` docId. 충돌 시 자릿수를 12→전체로 늘려 유일화. */
export function allocateDocId(surfaceId: string, existing: ReadonlySet<string>): string {
  const compact = surfaceId.replace(/-/g, "");
  for (const len of [8, 12, 16, compact.length]) {
    const candidate = `s-${compact.slice(0, len)}`;
    if (!existing.has(candidate)) return candidate;
  }
  // 최후: 전체 uuid.
  return `s-${surfaceId}`;
}

function emptySummary(write: boolean): ImportFromSurfacesSummary {
  return {
    dryRun: !write,
    totals: { candidates: 0, inserted: 0, skippedRegistered: 0, skippedNoPages: 0 },
    decisions: [],
  };
}

// ---------------------------------------------------------------------------
// CLI (직접 실행 시에만 main 구동 — 함수 재사용 시 부작용 없음)
// ---------------------------------------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  if (hasFlag("help")) {
    console.log(
      [
        "Usage: pnpm import:review-docs:from-surfaces -- [--limit=10] [--grantId=<uuid>] [--surfaceId=<uuid>] [--write]",
        "",
        "preview_ready surface(page_image 보유)를 field_map_review_docs 로 등재한다. docRef=surface:<id>.",
        "기본은 dry-run. --write 를 붙여야 실제 DB 쓰기가 일어난다. 이미 등재된 surface 는 스킵(멱등).",
      ].join("\n"),
    );
    return;
  }

  const db = getCunoteDb();
  const limitRaw = readArg("limit");
  const summary = await importReviewDocsFromSurfaces({
    db,
    limit: limitRaw ? Number(limitRaw) : DEFAULT_LIMIT,
    grantId: readArg("grantId") ?? null,
    surfaceId: readArg("surfaceId") ?? null,
    write: hasFlag("write"),
  });

  console.log(JSON.stringify(summary, null, 2));
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeCunoteDb();
    });
}

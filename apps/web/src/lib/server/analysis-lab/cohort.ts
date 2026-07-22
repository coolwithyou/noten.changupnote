// 공모 딥분석 실험실 — 코호트 선정·요약 (dev 전용, DB read-only).
// 기본 모드(파일럿 호환): 활성(open) 공고 중 markdown 첨부 보유 공고 우선으로
// kstartup/bizinfo 를 섞어 size(기본 3)건을 뽑는다. 층화 모드(stratified=true, 확대 실험
// 계획 §3): 소스×본문 두께 6층 배분 + 시드 랜덤 샘플링 + soft 쿼터(통합공고·A≥3) 보정.
// 재현성을 위해 코호트는 spike-out/analysis-lab/cohort.json(v2 — cohort-file.ts 단일 원천)에
// 저장해 재사용한다. refresh=true 로 재선정하되, 검수(review.json) 보유 공고는 보존한다.
// 저장된 grantId 가 DB에서 사라지면 그 자리만 재선정한다(층화 자리는 같은 층 → 인접 두께 폴백).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, count, desc, eq, exists, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { deriveGrantBenefits } from "@cunote/core";
import { getCunoteDb, type CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { toGrant } from "@/lib/server/archive/grantArchiveData";
import { benefitFamilyLabel } from "@/lib/server/archive/grantArchiveSearch";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabAttachment,
  type LabCohortResponse,
  type LabNoticeSummary,
} from "@/features/dev/analysis-lab/contract";
import {
  PILOT_STRATUM,
  readCohortFileV2,
  writeCohortFileV2,
  type CohortEntry,
  type CohortFileV2,
} from "./cohort-file";
import { resolveLabModel } from "./extractor";
import { BODY_MARKDOWN_MIN_BYTES, announcementScore } from "./input";
import { analysisLabDir, listLabRunSummaries } from "./run-store";
import {
  LAB_SOURCES,
  RICH_CRITERIA_MIN,
  TIER_FALLBACK,
  UNIFIED_NOTICE_PATTERN,
  parseStratumId,
  selectStratifiedCohort,
  groupShuffledByStratum,
  stratumIdOf,
  thicknessTierOf,
  type StratumCandidate,
} from "./strata";

/** 기본 코호트 크기 — 파일럿과 동일(비층화 3건). */
const DEFAULT_COHORT_SIZE = 3;
const MAX_COHORT_SIZE = 200;

export interface LoadLabCohortOptions {
  /** true 면 저장 코호트를 버리고 재선정(검수 보유 공고는 보존 가드로 유지). */
  refresh?: boolean | undefined;
  /** 코호트 크기(기본 3). 저장 코호트 재사용 시에는 저장분 크기를 따른다. */
  size?: number | undefined;
  /** true 면 소스×두께 6층 층화 선정(계획 §3). 기본 false — 현행 비층화 동작. */
  stratified?: boolean | undefined;
  /** 층 내 샘플링 시드 — 미지정 시 시각 기반 생성. 파일에 기록돼 재현 가능하다. */
  seed?: number | undefined;
  /** 실험 라벨(예: "expansion-s1") — 파일에 기록. */
  experimentLabel?: string | undefined;
}

export interface LabCohortQuotaStatus {
  target: number;
  achieved: number;
}

/** 코호트 선정 메타 — 층별 분포·쿼터·경고를 응답에 표시한다(계약 외 추가 필드, UI 는 무시 가능). */
export interface LabCohortMeta {
  stratified: boolean;
  seed: number | null;
  experimentLabel: string | null;
  selectedAt: string;
  /** 층별 선정 건수(저장 entries 기준). 비층화 코호트는 { pilot: n }. */
  strataCounts: Record<string, number>;
  /** soft 쿼터 충족 현황 — 층화 신규 선정 시에만 계산(재사용·비층화는 null). */
  quotas: { unified: LabCohortQuotaStatus; richCriteria: LabCohortQuotaStatus } | null;
  /** refresh 시 review.json 보유로 보존된 공고 수. */
  preservedReviewedCount: number;
  warnings: string[];
}

export interface LabCohortResult extends LabCohortResponse {
  cohortMeta: LabCohortMeta;
}

export async function loadLabCohort(options: LoadLabCohortOptions = {}): Promise<LabCohortResult> {
  const db = getCunoteDb();
  const size = normalizeSize(options.size);
  const stored = await readCohortFileV2();
  const warnings: string[] = [];
  let file: CohortFileV2;
  let quotas: LabCohortMeta["quotas"] = null;
  let preservedReviewedCount = 0;
  let stratified = options.stratified === true;

  if (!options.refresh && stored && stored.entries.length > 0) {
    // 저장 코호트 재사용 — DB에서 사라진 자리만 재선정(층화 자리는 같은 층 우선).
    file = await reuseStoredCohort(db, stored, warnings);
    stratified = file.entries.some((entry) => entry.stratum !== PILOT_STRATUM);
  } else {
    const fresh = await selectFreshCohort(db, {
      size,
      stratified,
      seed: options.seed,
      experimentLabel: options.experimentLabel ?? null,
      stored,
      warnings,
    });
    file = fresh.file;
    quotas = fresh.quotas;
    preservedReviewedCount = fresh.preservedReviewedCount;
    await writeCohortFileV2(file);
  }

  for (const warning of warnings) console.warn(`[analysis-lab cohort] ${warning}`);

  const notices: LabNoticeSummary[] = [];
  for (const entry of file.entries) {
    const notice = await buildNoticeSummary(db, entry.grantId);
    if (notice) notices.push(notice);
  }

  const strataCounts: Record<string, number> = {};
  for (const entry of file.entries) {
    strataCounts[entry.stratum] = (strataCounts[entry.stratum] ?? 0) + 1;
  }

  return {
    model: resolveLabModel(),
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    notices,
    cohortMeta: {
      stratified,
      seed: file.seed,
      experimentLabel: file.experimentLabel,
      selectedAt: file.selectedAt,
      strataCounts,
      quotas,
      preservedReviewedCount,
      warnings,
    },
  };
}

function normalizeSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_COHORT_SIZE;
  return Math.min(MAX_COHORT_SIZE, Math.max(1, Math.floor(size)));
}

// grants.id 는 uuid 컬럼 — 형식이 아닌 id 를 inArray 에 넣으면 캐스트 오류로 쿼리 전체가
// 실패한다. 코호트 파일이 오염돼도 죽지 않도록, uuid 형식만 DB에 물어보고 나머지는
// "사라진 공고"로 취급한다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchAliveGrantIds(db: CunoteDb, grantIds: string[]): Promise<Set<string>> {
  const validIds = grantIds.filter((id) => UUID_PATTERN.test(id));
  if (validIds.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(inArray(schema.grants.id, validIds));
  return new Set(rows.map((row) => row.id));
}

// ── 신규 선정 (refresh 포함) ──────────────────────────────────────

interface FreshSelectionInput {
  size: number;
  stratified: boolean;
  seed: number | undefined;
  experimentLabel: string | null;
  stored: CohortFileV2 | null;
  warnings: string[];
}

interface FreshSelectionResult {
  file: CohortFileV2;
  quotas: LabCohortMeta["quotas"];
  preservedReviewedCount: number;
}

async function selectFreshCohort(
  db: CunoteDb,
  input: FreshSelectionInput,
): Promise<FreshSelectionResult> {
  const { size, stored, warnings } = input;

  // 검수 보유 공고 보존 가드 — refresh 로 다시 뽑아도 검수 진행분의 코호트(UI) 접근을 잃지 않는다.
  let preserved: CohortEntry[] = [];
  if (stored && stored.entries.length > 0) {
    const reviewed = await reviewedGrantIdsOnDisk();
    const reviewedEntries = stored.entries.filter((entry) => reviewed.has(entry.grantId));
    if (reviewedEntries.length > 0) {
      const alive = await fetchAliveGrantIds(db, reviewedEntries.map((entry) => entry.grantId));
      preserved = reviewedEntries.filter((entry) => alive.has(entry.grantId));
      for (const entry of reviewedEntries) {
        if (!alive.has(entry.grantId)) {
          warnings.push(
            `검수 보유 공고 ${entry.grantId} 는 DB에서 사라져 보존 불가(검수 파일은 spike-out 에 남음)`,
          );
        }
      }
      if (preserved.length > 0) warnings.push(`검수 보유 공고 ${preserved.length}건 보존`);
    }
  }
  const needed = Math.max(0, size - preserved.length);
  if (preserved.length > size) {
    warnings.push(`검수 보존분(${preserved.length}건)이 요청 크기(${size}건)를 초과 — 보존분을 모두 유지`);
  }

  let entries: CohortEntry[];
  let quotas: LabCohortMeta["quotas"] = null;
  let seed: number | null = input.seed ?? null;

  if (input.stratified) {
    // 시드는 미지정 시 시각 기반으로 생성하되 반드시 파일에 기록한다(사후 재현 가능).
    seed = input.seed ?? Date.now() >>> 0;
    const candidates = await loadStratumCandidates(db, preserved.map((entry) => entry.grantId));
    const selection = selectStratifiedCohort(candidates, needed, seed);
    warnings.push(...selection.warnings);
    quotas = selection.quotas;
    entries = [
      ...preserved,
      ...selection.selected.map((candidate) => ({
        grantId: candidate.grantId,
        stratum: candidate.stratum,
      })),
    ];
  } else {
    // 비층화(현행 동작) — stratum 은 파일럿과 의미가 같은 "pilot" 로 기록한다.
    const ids = await selectCohortGrantIds(db, needed, preserved.map((entry) => entry.grantId));
    entries = [...preserved, ...ids.map((grantId) => ({ grantId, stratum: PILOT_STRATUM }))];
  }

  return {
    file: {
      version: 2,
      selectedAt: new Date().toISOString(),
      seed,
      experimentLabel: input.experimentLabel,
      entries,
    },
    quotas,
    preservedReviewedCount: preserved.length,
  };
}

// ── 저장 코호트 재사용 (사라진 자리만 재선정) ─────────────────────

async function reuseStoredCohort(
  db: CunoteDb,
  stored: CohortFileV2,
  warnings: string[],
): Promise<CohortFileV2> {
  const alive = await fetchAliveGrantIds(db, stored.entries.map((entry) => entry.grantId));
  const kept = stored.entries.filter((entry) => alive.has(entry.grantId));
  const dead = stored.entries.filter((entry) => !alive.has(entry.grantId));
  if (dead.length === 0) return stored;

  const reviewed = await reviewedGrantIdsOnDisk();
  for (const entry of dead) {
    if (reviewed.has(entry.grantId)) {
      warnings.push(
        `검수 보유 공고 ${entry.grantId} 가 DB에서 사라져 재선정 대체(검수 파일은 spike-out 에 남음)`,
      );
    }
  }

  const replacements: CohortEntry[] = [];
  const excludeIds = () => [...kept, ...replacements].map((entry) => entry.grantId);

  // pilot(비층화) 자리는 현행 방식으로 재선정.
  const deadPilot = dead.filter((entry) => entry.stratum === PILOT_STRATUM);
  if (deadPilot.length > 0) {
    const ids = await selectCohortGrantIds(db, deadPilot.length, excludeIds());
    replacements.push(...ids.map((grantId) => ({ grantId, stratum: PILOT_STRATUM })));
  }

  // 층화 자리는 같은 층에서 뽑고, 층 재고 소진 시 인접 두께 층 폴백 + 경고.
  const deadStratified = dead.filter((entry) => entry.stratum !== PILOT_STRATUM);
  if (deadStratified.length > 0) {
    const candidates = await loadStratumCandidates(db, excludeIds());
    // 결정론: 저장 시드(없으면 1)로 층 내부를 셔플해 앞에서부터 소비한다.
    const byStratum = groupShuffledByStratum(candidates, stored.seed ?? 1);
    for (const entry of deadStratified) {
      const replacement = pickStratumReplacement(byStratum, entry.stratum);
      if (!replacement) {
        warnings.push(`층 ${entry.stratum} 의 대체 후보 없음(인접 층 포함) — 코호트가 1건 줄어듦`);
        continue;
      }
      if (replacement.stratum !== entry.stratum) {
        warnings.push(`층 ${entry.stratum} 재고 소진 — 인접 층 ${replacement.stratum} 에서 대체 선정`);
      }
      replacements.push({ grantId: replacement.grantId, stratum: replacement.stratum });
    }
  }

  const next: CohortFileV2 = { ...stored, entries: [...kept, ...replacements] };
  await writeCohortFileV2(next);
  return next;
}

/** 같은 층 → (같은 소스의) 인접 두께 층 순서로 미사용 후보 1건을 꺼낸다. 소진 시 null. */
function pickStratumReplacement(
  byStratum: Map<string, StratumCandidate[]>,
  stratum: string,
): StratumCandidate | null {
  const parsed = parseStratumId(stratum);
  const tryOrder = parsed
    ? [stratum, ...TIER_FALLBACK[parsed.tier].map((tier) => stratumIdOf(parsed.source, tier))]
    : [stratum];
  for (const key of tryOrder) {
    const pool = byStratum.get(key);
    const candidate = pool?.shift();
    if (candidate) return candidate;
  }
  return null;
}

// ── 검수 파일 스캔 (보존 가드) ────────────────────────────────────

/**
 * spike-out/analysis-lab 하위 디렉토리에서 *.review.json 을 찾아 검수 보유 grantId 집합을
 * 만든다. run-store 의 analysisLabDir 기준 디렉토리 나열만 사용하고(파일 존재 여부 확인),
 * grantId 는 검수 파일 본문에서 관대하게 읽는다(형식 소유자는 review-store.ts).
 */
async function reviewedGrantIdsOnDisk(): Promise<Set<string>> {
  const reviewed = new Set<string>();
  const root = analysisLabDir();
  let dirEntries: string[];
  try {
    dirEntries = await readdir(root);
  } catch {
    return reviewed;
  }
  for (const dirEntry of dirEntries) {
    if (!dirEntry.includes("__")) continue; // cohort.json 등 파일 제외
    let files: string[];
    try {
      files = await readdir(join(root, dirEntry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".review.json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(root, dirEntry, file), "utf8")) as {
          grantId?: unknown;
        };
        if (typeof parsed.grantId === "string" && parsed.grantId.length > 0) {
          reviewed.add(parsed.grantId);
        }
      } catch {
        // 깨진 검수 파일은 보존 판단에서 제외(검수 저장은 review-store 몫).
      }
    }
  }
  return reviewed;
}

// ── 층화 후보 재고 조회 (read-only, 전 재고) ──────────────────────

/**
 * open 공고 전 재고를 층화 후보로 조립한다: 공고별 markdown 변환 첨부 최대 bytes(두께 티어),
 * 통합공고 여부(제목 정규식), 현행 grant_criteria ≥3 여부. rankByBodyMarkdown 과 달리
 * 후보 풀을 자르지 않는다 — 층 배분·쿼터가 전 재고를 전제로 하기 때문(계획 §3).
 */
async function loadStratumCandidates(
  db: CunoteDb,
  excludeIds: string[],
): Promise<StratumCandidate[]> {
  const grantRows = await db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
    })
    .from(schema.grants)
    .where(
      and(
        eq(schema.grants.status, "open"),
        inArray(schema.grants.source, [...LAB_SOURCES]),
        excludeIds.length > 0 ? notInArray(schema.grants.id, excludeIds) : undefined,
      ),
    );

  // 공고별 markdown 최대 bytes — 변환 완료(markdownStorageKey 보유) 첨부만 집계.
  const bytesRows = await db
    .select({
      source: schema.grantAttachmentArchives.source,
      sourceId: schema.grantAttachmentArchives.sourceId,
      maxBytes: sql<number | null>`max(${schema.grantAttachmentArchives.markdownBytes})`,
    })
    .from(schema.grantAttachmentArchives)
    .innerJoin(
      schema.grants,
      and(
        eq(schema.grants.source, schema.grantAttachmentArchives.source),
        eq(schema.grants.sourceId, schema.grantAttachmentArchives.sourceId),
      ),
    )
    .where(
      and(
        eq(schema.grants.status, "open"),
        isNotNull(schema.grantAttachmentArchives.markdownStorageKey),
      ),
    )
    .groupBy(schema.grantAttachmentArchives.source, schema.grantAttachmentArchives.sourceId);
  const bytesByKey = new Map(
    bytesRows.map((row) => [`${row.source} ${row.sourceId}`, Number(row.maxBytes ?? 0)]),
  );

  // 공고별 현행 criteria 수(A) — A≥3 쿼터 판별용.
  const criteriaRows = await db
    .select({ grantId: schema.grantCriteria.grantId, value: count() })
    .from(schema.grantCriteria)
    .innerJoin(schema.grants, eq(schema.grants.id, schema.grantCriteria.grantId))
    .where(and(eq(schema.grants.status, "open"), inArray(schema.grants.source, [...LAB_SOURCES])))
    .groupBy(schema.grantCriteria.grantId);
  const criteriaByGrant = new Map(criteriaRows.map((row) => [row.grantId, Number(row.value)]));

  return grantRows.map((row) => {
    const maxBytes = bytesByKey.get(`${row.source} ${row.sourceId}`) ?? 0;
    return {
      grantId: row.id,
      source: row.source,
      title: row.title,
      stratum: stratumIdOf(row.source, thicknessTierOf(maxBytes)),
      isUnified: UNIFIED_NOTICE_PATTERN.test(row.title),
      isRichCriteria: (criteriaByGrant.get(row.id) ?? 0) >= RICH_CRITERIA_MIN,
    };
  });
}

// ── 비층화 선정 로직 (파일럿과 동일) ───────────────────────────────

/** grants 행에 대응하는 markdown 변환 완료 첨부(archive)가 1개 이상 존재하는지(상관 서브쿼리). */
function markdownArchiveExists(db: CunoteDb) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(schema.grantAttachmentArchives)
      .where(
        and(
          eq(schema.grantAttachmentArchives.source, schema.grants.source),
          eq(schema.grantAttachmentArchives.sourceId, schema.grants.sourceId),
          isNotNull(schema.grantAttachmentArchives.markdownStorageKey),
        ),
      ),
  );
}

/**
 * 코호트 선정(v2 보정): 소스별로 markdown 보유 open 공고 후보 풀(updatedAt desc, 넉넉히)을 뽑은 뒤
 * "본문성 공고문 markdown(파일명 본문성 점수 > 0, BODY_MARKDOWN_MIN_BYTES 이상)" 보유 공고를
 * 최우선으로 정렬해 교차 선택한다 — 포스터·신청서만 있는 공고로 딥분석을 낭비하지 않기 위함.
 * markdown 보유 공고가 부족하면 markdown 없는 최신 open 공고로 채운다(markdownAvailable=false 로 표시됨).
 */
async function selectCohortGrantIds(
  db: CunoteDb,
  needed: number,
  excludeIds: string[],
): Promise<string[]> {
  if (needed <= 0) return [];
  const perSource: string[][] = [];
  for (const source of LAB_SOURCES) {
    const rows = await db
      .select({
        id: schema.grants.id,
        sourceId: schema.grants.sourceId,
        updatedAt: schema.grants.updatedAt,
      })
      .from(schema.grants)
      .where(
        and(
          eq(schema.grants.status, "open"),
          eq(schema.grants.source, source),
          markdownArchiveExists(db),
          excludeIds.length > 0 ? notInArray(schema.grants.id, excludeIds) : undefined,
        ),
      )
      .orderBy(desc(schema.grants.updatedAt))
      .limit(Math.max(40, needed * 2));
    perSource.push(await rankByBodyMarkdown(db, source, rows, needed + 2));
  }

  // kstartup/bizinfo 교차 선택(한 소스가 비면 다른 소스로 채움).
  const selected: string[] = [];
  for (let index = 0; selected.length < needed; index += 1) {
    let pushedAny = false;
    for (const candidates of perSource) {
      const candidate = candidates[index];
      if (candidate && !selected.includes(candidate)) {
        selected.push(candidate);
        pushedAny = true;
        if (selected.length >= needed) break;
      }
    }
    if (!pushedAny) break; // 양쪽 후보 소진
  }

  // 부족분은 markdown 없는 최신 open 공고로 채운다.
  if (selected.length < needed) {
    const exclude = [...excludeIds, ...selected];
    const fillRows = await db
      .select({ id: schema.grants.id })
      .from(schema.grants)
      .where(
        and(
          eq(schema.grants.status, "open"),
          inArray(schema.grants.source, [...LAB_SOURCES]),
          exclude.length > 0 ? notInArray(schema.grants.id, exclude) : undefined,
        ),
      )
      .orderBy(desc(schema.grants.updatedAt))
      .limit(needed - selected.length);
    selected.push(...fillRows.map((row) => row.id));
  }
  return selected;
}

/**
 * 후보 공고를 본문성 markdown 기준으로 재정렬한다.
 * 티어: 0=본문성 파일명 + BODY_MARKDOWN_MIN_BYTES 이상 / 1=크기만 충족 / 2=markdown 은 있으나 얇음.
 * 같은 티어 안에서는 markdown 최대 bytes 내림차순(후보 풀 자체가 최신순이라 recency 는 이미 반영됨).
 */
async function rankByBodyMarkdown(
  db: CunoteDb,
  source: (typeof LAB_SOURCES)[number],
  rows: Array<{ id: string; sourceId: string; updatedAt: Date | null }>,
  take: number,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const archiveRows = await db
    .select({
      sourceId: schema.grantAttachmentArchives.sourceId,
      filename: schema.grantAttachmentArchives.filename,
      markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
      markdownBytes: schema.grantAttachmentArchives.markdownBytes,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, source),
        inArray(schema.grantAttachmentArchives.sourceId, rows.map((row) => row.sourceId)),
        isNotNull(schema.grantAttachmentArchives.markdownStorageKey),
      ),
    );
  const bySourceId = new Map<string, { tier: number; maxBytes: number }>();
  for (const archive of archiveRows) {
    const bytes = archive.markdownBytes ?? 0;
    const bodyLike = announcementScore(archive.filename) > 0 && bytes >= BODY_MARKDOWN_MIN_BYTES;
    const tier = bodyLike ? 0 : bytes >= BODY_MARKDOWN_MIN_BYTES ? 1 : 2;
    const prev = bySourceId.get(archive.sourceId);
    if (!prev || tier < prev.tier || (tier === prev.tier && bytes > prev.maxBytes)) {
      bySourceId.set(archive.sourceId, { tier, maxBytes: Math.max(bytes, prev?.maxBytes ?? 0) });
    }
  }
  return rows
    .map((row) => ({ row, rank: bySourceId.get(row.sourceId) ?? { tier: 3, maxBytes: 0 } }))
    .sort((a, b) => a.rank.tier - b.rank.tier || b.rank.maxBytes - a.rank.maxBytes)
    .slice(0, take)
    .map((entry) => entry.row.id);
}

// ── 요약 조립 ─────────────────────────────────────────────────────

async function buildNoticeSummary(db: CunoteDb, grantId: string): Promise<LabNoticeSummary | null> {
  // 혜택 배지 산출(deriveGrantBenefits)이 benefits·support_amount·category·apply_method 등을
  // 두루 읽으므로 전체 행을 가져와 제품 공용 매퍼(toGrant)로 변환한다.
  const grantRows = await db
    .select()
    .from(schema.grants)
    .where(eq(schema.grants.id, grantId))
    .limit(1);
  const grant = grantRows[0];
  if (!grant) return null;

  const archiveRows = await db
    .select({
      filename: schema.grantAttachmentArchives.filename,
      markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
      markdownBytes: schema.grantAttachmentArchives.markdownBytes,
      conversionStatus: schema.grantAttachmentArchives.conversionStatus,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, grant.source),
        eq(schema.grantAttachmentArchives.sourceId, grant.sourceId),
      ),
    );
  const attachments: LabAttachment[] = archiveRows.map((row) => ({
    filename: row.filename,
    markdownAvailable: row.markdownStorageKey != null && row.markdownStorageKey.length > 0,
    markdownBytes: row.markdownBytes ?? null,
    conversionStatus: row.conversionStatus ?? null,
  }));

  const criteriaCountRows = await db
    .select({ value: count() })
    .from(schema.grantCriteria)
    .where(eq(schema.grantCriteria.grantId, grantId));

  // 혜택 배지 — 제품과 동일한 파생 로직·한국어 라벨(archive 어휘)을 그대로 쓴다.
  const benefits = deriveGrantBenefits(toGrant(grant)).map((benefit) => ({
    family: benefit.family,
    label: benefitFamilyLabel(benefit.family),
  }));

  return {
    grantId: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    agency: grant.agencyOperator ?? grant.agencyJurisdiction ?? null,
    applyStart: grant.applyStart ? grant.applyStart.toISOString() : null,
    applyEnd: grant.applyEnd ? grant.applyEnd.toISOString() : null,
    status: grant.status,
    url: grant.url ?? null,
    benefits,
    attachments,
    currentCriteriaCount: criteriaCountRows[0]?.value ?? 0,
    runs: await listLabRunSummaries(grant.source, grant.sourceId),
  };
}

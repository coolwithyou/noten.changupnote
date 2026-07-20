// 공모 딥분석 실험실 — 코호트 선정·요약 (dev 전용, DB read-only).
// 활성(open) 공고 중 markdown 첨부 보유 공고 우선으로 kstartup/bizinfo 를 섞어 3건을 뽑고,
// 재현성을 위해 grantId 목록을 spike-out/analysis-lab/cohort.json 에 저장해 재사용한다.
// refresh=true 로 재선정할 수 있고, 저장된 grantId 가 DB에서 사라지면 그 자리만 재선정한다.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { resolveLabModel } from "./extractor";
import { BODY_MARKDOWN_MIN_BYTES, announcementScore } from "./input";
import { analysisLabDir, listLabRunSummaries } from "./run-store";

const COHORT_SIZE = 3;
// 실험 대상 소스 — bizinfo_event(행사)는 공모 분석 대상이 아니라 제외.
const LAB_SOURCES = ["kstartup", "bizinfo"] as const;

interface CohortFile {
  version: 1;
  selectedAt: string;
  grantIds: string[];
}

function cohortFilePath(): string {
  return join(analysisLabDir(), "cohort.json");
}

export async function loadLabCohort(options: { refresh?: boolean } = {}): Promise<LabCohortResponse> {
  const db = getCunoteDb();
  const stored = options.refresh ? null : await readCohortFile();

  let grantIds: string[];
  if (stored && stored.grantIds.length > 0) {
    // 저장 코호트 재사용 — DB에서 사라진 자리만 재선정.
    const aliveRows = await db
      .select({ id: schema.grants.id })
      .from(schema.grants)
      .where(inArray(schema.grants.id, stored.grantIds));
    const alive = new Set(aliveRows.map((row) => row.id));
    const kept = stored.grantIds.filter((id) => alive.has(id));
    const missing = COHORT_SIZE - kept.length;
    grantIds = missing > 0 ? [...kept, ...(await selectCohortGrantIds(db, missing, kept))] : kept;
    if (grantIds.join("\n") !== stored.grantIds.join("\n")) {
      await writeCohortFile(grantIds);
    }
  } else {
    grantIds = await selectCohortGrantIds(db, COHORT_SIZE, []);
    await writeCohortFile(grantIds);
  }

  const notices: LabNoticeSummary[] = [];
  for (const grantId of grantIds) {
    const notice = await buildNoticeSummary(db, grantId);
    if (notice) notices.push(notice);
  }
  return {
    model: resolveLabModel(),
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    notices,
  };
}

// ── 선정 로직 ─────────────────────────────────────────────────────

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
      .limit(40);
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

// ── 코호트 파일 IO ────────────────────────────────────────────────

async function readCohortFile(): Promise<CohortFile | null> {
  try {
    const body = await readFile(cohortFilePath(), "utf8");
    const parsed = JSON.parse(body) as CohortFile;
    if (!Array.isArray(parsed.grantIds)) return null;
    return {
      version: 1,
      selectedAt: typeof parsed.selectedAt === "string" ? parsed.selectedAt : "",
      grantIds: parsed.grantIds.filter((id): id is string => typeof id === "string"),
    };
  } catch {
    return null;
  }
}

async function writeCohortFile(grantIds: string[]): Promise<void> {
  const path = cohortFilePath();
  await mkdir(dirname(path), { recursive: true });
  const file: CohortFile = { version: 1, selectedAt: new Date().toISOString(), grantIds };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

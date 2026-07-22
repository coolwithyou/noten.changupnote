// 코호트 파일(cohort.json) IO — cohort.ts(선정)·aggregate.ts(집계 필터)·batch.ts(배치 실행)가
// 공유하는 단일 모듈. v2 는 층화 확대 실험용으로 층(stratum)·시드·실험 라벨을 기록하며,
// v1 파일({grantIds})은 stratum "pilot" 으로 정규화해 읽는다(하위 호환).
// 층 식별자 형식: "<source>/<tier>" (예: "bizinfo/thick", "kstartup/thin") 또는 "pilot".
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analysisLabDir } from "./run-store";

export interface CohortEntry {
  grantId: string;
  /** 층 식별자 — 층별 집계(aggregate)와 같은 층 내 재선정(cohort)의 조인 키. */
  stratum: string;
}

export interface CohortFileV2 {
  version: 2;
  selectedAt: string;
  /** 층 내 샘플링 시드(재현성). v1 호환 읽기·비층화 선정은 null. */
  seed: number | null;
  /** 실험 라벨 — 예: "expansion-s1". 파일럿(v1)은 null. */
  experimentLabel: string | null;
  entries: CohortEntry[];
}

/** v1 파일럿 코호트의 stratum 표기 — 확대 집계에서 파일럿 층을 격리(낙관 편향)하는 데 쓴다. */
export const PILOT_STRATUM = "pilot";

export function cohortFilePath(): string {
  return join(analysisLabDir(), "cohort.json");
}

/**
 * cohort.json 을 v2 로 정규화해 읽는다. v1({grantIds: string[]})은 stratum "pilot" 으로
 * 변환한다. 파일이 없거나 형식이 깨졌으면 null.
 */
export async function readCohortFileV2(): Promise<CohortFileV2 | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(cohortFilePath(), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (record.version === 2 && Array.isArray(record.entries)) {
    const entries = record.entries
      .filter(
        (entry): entry is { grantId: string; stratum?: unknown } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).grantId === "string",
      )
      .map((entry) => ({
        grantId: entry.grantId,
        stratum: typeof entry.stratum === "string" && entry.stratum.length > 0 ? entry.stratum : PILOT_STRATUM,
      }));
    return {
      version: 2,
      selectedAt: typeof record.selectedAt === "string" ? record.selectedAt : "",
      seed: typeof record.seed === "number" ? record.seed : null,
      experimentLabel: typeof record.experimentLabel === "string" ? record.experimentLabel : null,
      entries,
    };
  }

  // v1 하위 호환 — {version:1, grantIds}.
  if (Array.isArray(record.grantIds)) {
    return {
      version: 2,
      selectedAt: typeof record.selectedAt === "string" ? record.selectedAt : "",
      seed: null,
      experimentLabel: null,
      entries: record.grantIds
        .filter((id): id is string => typeof id === "string")
        .map((grantId) => ({ grantId, stratum: PILOT_STRATUM })),
    };
  }
  return null;
}

export async function writeCohortFileV2(file: CohortFileV2): Promise<void> {
  const path = cohortFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/**
 * 결정론 PRNG(mulberry32) — 층 내 샘플링의 재현성을 위해 시드 고정 난수를 쓴다.
 * (Math.random 금지 취지: 같은 시드·같은 재고면 같은 코호트가 나와야 한다.)
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

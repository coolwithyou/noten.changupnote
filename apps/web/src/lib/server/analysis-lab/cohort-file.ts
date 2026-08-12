// 코호트 파일(cohort.json) IO — cohort.ts(선정)·aggregate.ts(집계 필터)·batch.ts(배치 실행)가
// 공유하는 단일 모듈. v2 는 층화 확대 실험용으로 층(stratum)·시드·실험 라벨을 기록하며,
// v1 파일({grantIds})은 stratum "pilot" 으로 정규화해 읽는다(하위 호환).
// 층 식별자 형식: "<source>/<tier>" (예: "bizinfo/thick", "kstartup/thin") 또는 "pilot".
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const COHORT_SNAPSHOT_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/**
 * 불변 코호트 스냅샷 경로. 라벨은 파일명 조각으로만 쓰이므로 소문자·숫자·하이픈만
 * 허용한다. CLI 입력이 analysis-lab 루트 밖으로 탈출하지 못하게 하는 단일 경계다.
 */
export function cohortSnapshotFilePath(label: string): string {
  if (!COHORT_SNAPSHOT_LABEL_PATTERN.test(label)) {
    throw new Error(
      `코호트 스냅샷 라벨 형식이 잘못됐습니다: "${label}" — 소문자·숫자·하이픈 1~80자만 허용합니다.`,
    );
  }
  return join(analysisLabDir(), `cohort.${label}.json`);
}

/**
 * cohort.json 을 v2 로 정규화해 읽는다. v1({grantIds: string[]})은 stratum "pilot" 으로
 * 변환한다. 파일이 없거나 형식이 깨졌으면 null.
 */
export async function readCohortFileV2(path = cohortFilePath()): Promise<CohortFileV2 | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
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

export async function writeCohortFileV2(
  file: CohortFileV2,
  options: { path?: string; exclusive?: boolean } = {},
): Promise<void> {
  const path = options.path ?? cohortFilePath();
  await mkdir(dirname(path), { recursive: true });
  if (options.exclusive) {
    // 게이트 표본은 실행 후에도 같은 이름으로 바뀌면 안 된다. run-store 와 같은 wx 계약으로
    // 기존 스냅샷을 덮어쓰지 않고 즉시 실패한다.
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return;
  }
  // 분석 대상 자동 선정과 배치 요약이 동시에 파일을 읽어도 반쪽 JSON을 보지 않도록
  // 같은 디렉터리의 임시 파일을 완성한 뒤 원자적으로 교체한다.
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
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

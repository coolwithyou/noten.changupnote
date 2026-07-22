// 공모 딥분석 실험실 — 검수 런 수집 공유 모듈 (dev 전용, DB·네트워크 미사용).
// aggregate.ts(검수 집계)와 shadow.ts(매칭 임팩트 섀도 측정)가 같은 대상 선정 규칙을
// 공유하도록 aggregate 의 로직을 추출했다:
//   ① spike-out/analysis-lab/ 의 <runId>.review.json 을 런 파일과 짝짓고
//   ② 기본은 cohort.json(cohort-file.ts, v1 은 stratum "pilot" 정규화)의 코호트 공고만
//      남긴다(다른 실험 검수의 혼입 차단). --all 이면 전수, cohort.json 이 없으면 전수 폴백.
//   ②′ excludePilotStratum(집계 전용): 검수 보존 가드가 파일럿을 확대 코호트 안에 남기므로,
//      게이트 판정 표본에서 파일럿 층을 추가로 제외한다(확대 계획 §3 사전 등록 — 구조화
//      게이트 수치를 유도한 데이터의 재진입 순환 차단). 섀도 측정은 "30건 검수 확정분"이라
//      파일럿을 포함한다(계획 §4) — 그래서 기본값이 아니라 옵션이다.
//   ③ 실패 런 검수 제외 + 같은 공고(grantId)는 최신(updatedAt) 검수 1건만 남긴다.
// 안내·경고 문구는 aggregate 의 기존 출력과 동일해야 한다(리팩토링 무변경 계약).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabReview, LabRun } from "@/features/dev/analysis-lab/contract";
import { PILOT_STRATUM, type CohortFileV2, readCohortFileV2 } from "./cohort-file";
import { analysisLabDir } from "./run-store";

export interface ReviewedRun {
  run: LabRun;
  review: LabReview;
}

/** 짝지어진 검수 런의 선정 결과 — 호출부(집계·섀도)가 코호트 정보까지 함께 소비한다. */
export interface ReviewedRunSelection {
  /** cohort.json(v2 정규화). 없거나 깨졌으면 null(전수 폴백). */
  cohort: CohortFileV2 | null;
  /** grantId → stratum (코호트 중복 grantId 는 첫 항목 우선 — aggregate 기존 규칙). */
  stratumByGrant: Map<string, string>;
  /** 코호트 필터 적용 후(전수 스캔이면 전체) — dedupe 전 풀. */
  pool: ReviewedRun[];
  /** 공고당 최신 검수 1건(실패 런 제외) — 지표 계산의 최종 대상. */
  reviewed: ReviewedRun[];
}

/** spike-out/analysis-lab/ 전수 스캔 — review.json 과 같은 runId 의 런 파일을 짝짓는다. */
export async function collectReviewedRuns(): Promise<ReviewedRun[]> {
  const root = analysisLabDir();
  const reviewed: ReviewedRun[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue;
    let files: string[] = [];
    try {
      files = await readdir(join(root, entry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".review.json")) continue;
      try {
        const review = JSON.parse(
          await readFile(join(root, entry, file), "utf8"),
        ) as LabReview;
        const run = JSON.parse(
          await readFile(join(root, entry, file.replace(/\.review\.json$/, ".json")), "utf8"),
        ) as LabRun;
        reviewed.push({ run, review });
      } catch {
        console.warn(`[경고] 검수/런 파일 파싱 실패 — 건너뜀: ${entry}/${file}`);
      }
    }
  }
  return reviewed;
}

/**
 * 집계 대상 정제 — 실패 런의 검수는 제외하고, 같은 공고(grantId)에 검수가 여러 개면
 * 최신(updatedAt) 1건만 남긴다. "공고당" 지표(누락·커버리지)의 분모를 공고 수와
 * 일치시키기 위함이며, 제외분은 침묵하지 않고 경고로 드러낸다.
 */
export function dedupeReviewedRuns(all: ReviewedRun[]): ReviewedRun[] {
  const byGrant = new Map<string, ReviewedRun>();
  for (const item of all) {
    if (item.run.error !== null) {
      console.warn(
        `[경고] 실패 런의 검수는 집계에서 제외: ${item.run.source}/${item.run.sourceId} ${item.run.runId}`,
      );
      continue;
    }
    const previous = byGrant.get(item.run.grantId);
    if (!previous) {
      byGrant.set(item.run.grantId, item);
      continue;
    }
    const [kept, droppedItem] =
      previous.review.updatedAt >= item.review.updatedAt ? [previous, item] : [item, previous];
    byGrant.set(kept.run.grantId, kept);
    console.warn(
      `[경고] 같은 공고의 검수 ${droppedItem.run.runId} 제외 — 공고당 최신 검수 1건(${kept.run.runId})만 집계`,
    );
  }
  return [...byGrant.values()];
}

/**
 * 수집 → 코호트 필터(기본) → dedupe 를 한 번에 수행한다. 콘솔 출력 순서는
 * aggregate 의 기존 흐름(파싱 경고 → 필터 안내/경고 → dedupe 경고)과 동일하다.
 */
export async function selectReviewedRuns(options: {
  scanAll: boolean;
  /** true 면 코호트 필터 뒤 stratum=pilot 검수도 제외한다(게이트 판정 표본 전용 — 모듈 주석 ②′). */
  excludePilotStratum?: boolean;
}): Promise<ReviewedRunSelection> {
  const cohort = await readCohortFileV2();
  const stratumByGrant = new Map<string, string>();
  if (cohort) {
    for (const entry of cohort.entries) {
      if (!stratumByGrant.has(entry.grantId)) stratumByGrant.set(entry.grantId, entry.stratum);
    }
  }

  const all = await collectReviewedRuns();
  let pool = all;
  if (!options.scanAll) {
    if (cohort === null) {
      console.log("[안내] cohort.json 이 없습니다 — 전수 스캔으로 집계합니다(--all 과 동일 동작).");
    } else {
      pool = all.filter((item) => stratumByGrant.has(item.run.grantId));
      const filteredOut = all.length - pool.length;
      if (filteredOut > 0) {
        console.warn(
          `[경고] 코호트 밖 검수 ${filteredOut}건 제외 — 다른 실험(파일럿 등) 검수의 혼입 차단. 포함하려면 --all.`,
        );
      }
      if (options.excludePilotStratum === true) {
        const withoutPilot = pool.filter(
          (item) => stratumByGrant.get(item.run.grantId) !== PILOT_STRATUM,
        );
        const pilotExcluded = pool.length - withoutPilot.length;
        if (pilotExcluded > 0) {
          console.log(
            `[안내] 파일럿(stratum=pilot) 검수 ${pilotExcluded}건 제외 — 게이트 판정 표본 사전 등록(확대 계획 §3, 순환 차단). 포함치(민감도 참고)는 --all.`,
          );
        }
        pool = withoutPilot;
      }
    }
  }

  const reviewed = dedupeReviewedRuns(pool);
  return { cohort, stratumByGrant, pool, reviewed };
}

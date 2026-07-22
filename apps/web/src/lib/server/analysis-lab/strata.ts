// 공모 딥분석 실험실 — 층화 선정 순수 로직 (dev 전용, DB 미접근).
// 층 = 소스(kstartup/bizinfo) × 본문 두께 3티어. 두께는 공고의 markdown 변환 첨부
// "최대 bytes" 기준(확대 실험 계획 §3 재구간화): thick >30KB / medium ≥2KB / thin 그 미만·없음.
// DB 조회·파일 IO 는 cohort.ts 가 담당하고, 이 모듈은 배분·시드 샘플링·쿼터 스왑만 계산한다
// (순수 함수 — 같은 입력·같은 시드면 항상 같은 코호트).
import { seededRandom } from "./cohort-file";
import { BODY_MARKDOWN_MIN_BYTES } from "./input";

// 실험 대상 소스 — bizinfo_event(행사)는 공모 분석 대상이 아니라 제외.
export const LAB_SOURCES = ["kstartup", "bizinfo"] as const;
export type LabSource = (typeof LAB_SOURCES)[number];

export type ThicknessTier = "thick" | "medium" | "thin";

/** 두꺼움 티어 하한(초과) — 계획 §3 "두꺼움(>30KB)". */
export const THICK_MIN_BYTES = 30_000;

/** 통합공고 판별 — 제목 정규식(계획 §3 쿼터, 신설). */
export const UNIFIED_NOTICE_PATTERN = /통합\s*공고/;

/** "현행 criteria 가 충실한 공고(A≥3)" 쿼터의 기준 건수. */
export const RICH_CRITERIA_MIN = 3;

// 30건 기준 배분(계획 §3 실측 반영) — size≠30 이면 size/30 비례 스케일(단순 규칙).
// kstartup thick/medium 은 재고가 2·4건뿐이라 "재고 전량(각 최대 5)" 규칙이다.
const BASE_SIZE = 30;
const KSTARTUP_RICH_CAP_BASE = 5;
const BIZINFO_THICK_QUOTA_BASE = 8;
const BIZINFO_MEDIUM_QUOTA_BASE = 8;
const UNIFIED_QUOTA_BASE = 4; // 통합공고 ≥4건(30건 기준, soft)
const RICH_CRITERIA_QUOTA_BASE = 6; // 현행 A≥3 공고 ≥6건(30건 기준, soft)

export function thicknessTierOf(maxMarkdownBytes: number): ThicknessTier {
  if (maxMarkdownBytes > THICK_MIN_BYTES) return "thick";
  if (maxMarkdownBytes >= BODY_MARKDOWN_MIN_BYTES) return "medium";
  return "thin";
}

/** 층 식별자 — "<source>/<tier>" (예: "bizinfo/thick"). cohort.json v2 stratum 과 동일 표기. */
export function stratumIdOf(source: string, tier: ThicknessTier): string {
  return `${source}/${tier}`;
}

export function parseStratumId(stratum: string): { source: string; tier: ThicknessTier } | null {
  const [source, tier] = stratum.split("/");
  if (!source || (tier !== "thick" && tier !== "medium" && tier !== "thin")) return null;
  return { source, tier };
}

/** 같은 소스 안에서의 인접 두께 폴백 순서 — 층 재고 소진 시 재선정 대체에 쓴다. */
export const TIER_FALLBACK: Record<ThicknessTier, ThicknessTier[]> = {
  thick: ["medium", "thin"],
  medium: ["thick", "thin"],
  thin: ["medium", "thick"],
};

/** 층화 선정 후보 1건 — cohort.ts 가 DB(read-only)에서 조립해 넘긴다. */
export interface StratumCandidate {
  grantId: string;
  source: string;
  title: string;
  stratum: string;
  /** 통합공고 여부(제목 정규식). */
  isUnified: boolean;
  /** 현행 grant_criteria ≥3 보유 여부. */
  isRichCriteria: boolean;
}

export interface StratumQuotaStatus {
  target: number;
  achieved: number;
}

export interface StratifiedSelection {
  selected: StratumCandidate[];
  /** soft 쿼터 충족 현황 — 미충족이어도 억지로 채우지 않는다(warnings 에 기록). */
  quotas: { unified: StratumQuotaStatus; richCriteria: StratumQuotaStatus };
  warnings: string[];
}

function scaleBySize(base: number, size: number): number {
  return Math.max(0, Math.round((base * size) / BASE_SIZE));
}

/** Fisher–Yates — 시드 rng 로만 섞는다(Math.random 금지). */
function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
}

/**
 * 후보를 층별로 묶고 층 내부를 시드 셔플한다. DB 반환 순서의 비결정성을 없애기 위해
 * 먼저 grantId 로 정렬한 뒤, 층 키 정렬 순서로 하나의 rng 를 이어 쓴다 —
 * 같은 시드·같은 재고면 결과가 항상 같다.
 */
export function groupShuffledByStratum(
  candidates: StratumCandidate[],
  seed: number,
): Map<string, StratumCandidate[]> {
  const sorted = [...candidates].sort((a, b) =>
    a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0,
  );
  const byStratum = new Map<string, StratumCandidate[]>();
  for (const candidate of sorted) {
    const group = byStratum.get(candidate.stratum);
    if (group) group.push(candidate);
    else byStratum.set(candidate.stratum, [candidate]);
  }
  const rng = seededRandom(seed);
  for (const key of [...byStratum.keys()].sort()) {
    const group = byStratum.get(key);
    if (group) shuffleInPlace(group, rng);
  }
  return byStratum;
}

/**
 * 층별 배분(계획 §3, 30건 기준값의 비례 스케일):
 * kstartup thick/medium 재고 전량(각 최대 5) → bizinfo thick 8·medium 8 → 잔여는 thin 으로
 * kstartup/bizinfo 균등 시도(한쪽 재고 부족 시 반대편이 흡수). thin 까지 소진되면 재고가
 * 남은 아무 층에서 라운드로빈으로 채워 총량 미달을 막는다.
 */
export function allocateStratifiedQuotas(
  size: number,
  available: Map<string, number>,
): Map<string, number> {
  const quotas = new Map<string, number>();
  const availOf = (key: string) => available.get(key) ?? 0;
  const grant = (key: string, want: number): number => {
    const current = quotas.get(key) ?? 0;
    const got = Math.max(0, Math.min(want, availOf(key) - current));
    if (got > 0) quotas.set(key, current + got);
    return got;
  };
  const fillRoundRobin = (keys: string[], amount: number): number => {
    let remaining = amount;
    while (remaining > 0) {
      let progressed = false;
      for (const key of keys) {
        if (remaining <= 0) break;
        if (grant(key, 1) > 0) {
          remaining -= 1;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    return amount - remaining;
  };

  let used = 0;
  used += grant(stratumIdOf("kstartup", "thick"), scaleBySize(KSTARTUP_RICH_CAP_BASE, size));
  used += grant(stratumIdOf("kstartup", "medium"), scaleBySize(KSTARTUP_RICH_CAP_BASE, size));
  used += grant(stratumIdOf("bizinfo", "thick"), scaleBySize(BIZINFO_THICK_QUOTA_BASE, size));
  used += grant(stratumIdOf("bizinfo", "medium"), scaleBySize(BIZINFO_MEDIUM_QUOTA_BASE, size));
  // 잔여 → thin 균등 시도.
  used += fillRoundRobin(
    [stratumIdOf("kstartup", "thin"), stratumIdOf("bizinfo", "thin")],
    Math.max(0, size - used),
  );
  // 최후 보정 — 재고가 남은 층 전체에서 채운다(키 정렬 순서, 결정론).
  if (used < size) fillRoundRobin([...available.keys()].sort(), size - used);
  return quotas;
}

interface QuotaDef {
  label: string;
  target: number;
  matches: (candidate: StratumCandidate) => boolean;
}

/**
 * 층화 코호트 선정: 층별 시드 셔플 → 배분 쿼터만큼 선택 → soft 쿼터(통합공고·A≥3) 미충족분을
 * "같은 층의 미선정 후보와 스왑"으로 보정한다. 스왑으로도 미충족이면 억지로 채우지 않고
 * warnings 에 남긴다(호출자가 콘솔 경고·응답 표시).
 */
export function selectStratifiedCohort(
  candidates: StratumCandidate[],
  size: number,
  seed: number,
): StratifiedSelection {
  const warnings: string[] = [];
  const byStratum = groupShuffledByStratum(candidates, seed);
  const strata = [...byStratum.keys()].sort();
  const available = new Map(strata.map((key) => [key, byStratum.get(key)?.length ?? 0]));
  const allocation = allocateStratifiedQuotas(size, available);

  const selectedByStratum = new Map<string, StratumCandidate[]>();
  const poolByStratum = new Map<string, StratumCandidate[]>();
  for (const key of strata) {
    const group = byStratum.get(key) ?? [];
    const take = allocation.get(key) ?? 0;
    selectedByStratum.set(key, group.slice(0, take));
    poolByStratum.set(key, group.slice(take));
  }

  const quotaDefs: QuotaDef[] = [
    {
      label: "통합공고",
      target: scaleBySize(UNIFIED_QUOTA_BASE, size),
      matches: (candidate) => candidate.isUnified,
    },
    {
      label: "현행 A≥3",
      target: scaleBySize(RICH_CRITERIA_QUOTA_BASE, size),
      matches: (candidate) => candidate.isRichCriteria,
    },
  ];
  const countMatches = (def: QuotaDef): number => {
    let total = 0;
    for (const group of selectedByStratum.values()) {
      for (const candidate of group) if (def.matches(candidate)) total += 1;
    }
    return total;
  };
  // 스왑 피해자: 이 쿼터를 만족하지 않으면서, 이미 딱 맞게 충족된 다른 쿼터를 깨지 않는
  // 항목을 뒤(선정 순서 후순위)에서부터 고른다.
  const findVictimIndex = (selected: StratumCandidate[], def: QuotaDef): number => {
    for (let i = selected.length - 1; i >= 0; i -= 1) {
      const victim = selected[i];
      if (!victim || def.matches(victim)) continue;
      const breaksOther = quotaDefs.some(
        (other) => other !== def && other.matches(victim) && countMatches(other) <= other.target,
      );
      if (!breaksOther) return i;
    }
    return -1;
  };

  for (const def of quotaDefs) {
    let count = countMatches(def);
    for (const key of strata) {
      if (count >= def.target) break;
      const pool = poolByStratum.get(key) ?? [];
      const selected = selectedByStratum.get(key) ?? [];
      for (let p = 0; p < pool.length && count < def.target; p += 1) {
        const incoming = pool[p];
        if (!incoming || !def.matches(incoming)) continue;
        const victimIndex = findVictimIndex(selected, def);
        if (victimIndex < 0) break; // 이 층에선 스왑 여지 없음
        const victim = selected[victimIndex];
        if (!victim) break;
        selected[victimIndex] = incoming;
        pool[p] = victim;
        count += 1;
      }
    }
    if (count < def.target) {
      warnings.push(`쿼터 미충족(soft): ${def.label} ${count}/${def.target}건 — 스왑 후보 소진, 억지 충원 안 함`);
    }
  }

  const selected = strata.flatMap((key) => selectedByStratum.get(key) ?? []);
  if (selected.length < size) {
    warnings.push(`층 재고 부족: 목표 ${size}건 중 ${selected.length}건만 선정됨`);
  }
  const unifiedDef = quotaDefs[0];
  const richDef = quotaDefs[1];
  return {
    selected,
    quotas: {
      unified: { target: unifiedDef?.target ?? 0, achieved: unifiedDef ? countMatches(unifiedDef) : 0 },
      richCriteria: { target: richDef?.target ?? 0, achieved: richDef ? countMatches(richDef) : 0 },
    },
    warnings,
  };
}

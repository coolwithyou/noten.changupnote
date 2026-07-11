/**
 * 상호 퍼지 매칭 — 사업자/법인번호가 없는 registry 행의 조인 키.
 *
 * 문자 bigram(2-gram) Sørensen–Dice 계수. 결정적이고 의존성 없음. 짧은 문자열은
 * bigram 이 부족해 계수가 급락하므로(제재 명단에선 오탐보다 미탐이 안전) 그대로 둔다.
 * representative·regionSido 가 양쪽에 있고 일치하면 소폭 가산해 이름만으로 애매한
 * 경계를 보강한다.
 */

import type { RegistryQuery, RegistryRecord } from "./types.js";
import { normalizeCompanyName } from "./normalize.js";

/** representative 일치 시 가산치. */
const REPRESENTATIVE_BONUS = 0.1;
/** regionSido 일치 시 가산치. */
const REGION_BONUS = 0.05;

function bigramCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const bg = s.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  return counts;
}

/**
 * 이미 정규화된 두 상호의 유사도 0..1.
 * - 완전일치 = 1, 빈 문자열 관여 = 0.
 * - 길이 1 이하는 bigram 이 없어 완전일치 여부로만 판정.
 * - 그 외 bigram Dice: 2·|교집합| / (|A| + |B|).
 */
export function nameSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bgA = bigramCounts(a);
  const bgB = bigramCounts(b);

  let totalA = 0;
  for (const count of bgA.values()) totalA += count;
  let totalB = 0;
  let intersection = 0;
  for (const [bg, count] of bgB) {
    totalB += count;
    const inA = bgA.get(bg);
    if (inA !== undefined) intersection += Math.min(inA, count);
  }

  return (2 * intersection) / (totalA + totalB);
}

function normalizeSimpleToken(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * query.name 을 정규화해 record.nameNormalized 와 유사도 산출.
 * representative·regionSido 가 양쪽에 존재하고 일치하면 가산(상한 1.0).
 * query.name 이 없으면 0.
 */
export function fuzzyNameScore(query: RegistryQuery, record: RegistryRecord): number {
  const qName = normalizeCompanyName(query.name ?? null);
  if (qName === "") return 0;

  let score = nameSimilarity(qName, record.nameNormalized);

  const qRep = normalizeSimpleToken(query.representative);
  const rRep = normalizeSimpleToken(record.representative);
  if (qRep !== "" && rRep !== "" && qRep === rRep) {
    score += REPRESENTATIVE_BONUS;
  }

  const qRegion = normalizeSimpleToken(query.regionSido);
  const rRegion = normalizeSimpleToken(record.regionSido);
  if (qRegion !== "" && rRegion !== "" && qRegion === rRegion) {
    score += REGION_BONUS;
  }

  return Math.min(1, score);
}

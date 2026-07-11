/**
 * 인메모리 registry 조회 매처 — 순수 함수(DB 없음).
 *
 * records 는 호출측이 registry_index 에서 로드해 주입한다(후속 조회 계층). 여기선
 * 사업자번호 → 법인번호 → 상호 퍼지 순으로 우선순위를 두어 매칭하고, 활성창(validUntil)
 * 을 판정한다. 정렬은 정확도(method) → 점수 → 활성 우선.
 */

import type { RegistryMatch, RegistryMatchMethod, RegistryQuery, RegistryRecord } from "./types.js";
import { sanitizeBizNo, sanitizeCorpNo } from "./normalize.js";
import { fuzzyNameScore } from "./fuzzy-match.js";

/** 정렬용 method 우선순위(작을수록 우선). */
const METHOD_RANK: Record<RegistryMatchMethod, number> = {
  exact_biz_no: 0,
  exact_corp_no: 1,
  fuzzy_name: 2,
};

/** 기본 퍼지 임계값. 이 값 이상이어야 fuzzy_name 매칭으로 채택. */
const DEFAULT_FUZZY_THRESHOLD = 0.6;

/**
 * records 중 query 에 매칭되는 항목을 RegistryMatch[] 로. 각 record 는 최대 1개 method 로
 * 채택된다(사업자 > 법인 > 이름). 정확 매칭이 있으면 퍼지는 시도하지 않는다.
 */
export function matchRegistry(
  records: RegistryRecord[],
  query: RegistryQuery,
  opts?: { fuzzyThreshold?: number },
): RegistryMatch[] {
  const threshold = opts?.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const queryBizNo = sanitizeBizNo(query.bizNo);
  const queryCorpNo = sanitizeCorpNo(query.corpNo);
  const nowMs = (query.now ?? new Date()).getTime();

  const matches: RegistryMatch[] = [];

  for (const record of records) {
    let method: RegistryMatchMethod | null = null;
    let score = 0;

    if (queryBizNo !== null && record.bizNo !== null && record.bizNo === queryBizNo) {
      method = "exact_biz_no";
      score = 1;
    } else if (queryCorpNo !== null && record.corpNo !== null && record.corpNo === queryCorpNo) {
      method = "exact_corp_no";
      score = 1;
    } else if (query.name !== null && query.name !== undefined && query.name !== "") {
      const fuzzy = fuzzyNameScore(query, record);
      if (fuzzy >= threshold) {
        method = "fuzzy_name";
        score = fuzzy;
      }
    }

    if (method === null) continue;

    const active = record.validUntil === null || record.validUntil.getTime() >= nowMs;
    matches.push({ record, method, score, active });
  }

  matches.sort((a, b) => {
    const rankDiff = METHOD_RANK[a.method] - METHOD_RANK[b.method];
    if (rankDiff !== 0) return rankDiff;
    if (b.score !== a.score) return b.score - a.score;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return 0;
  });

  return matches;
}

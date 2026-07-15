export const GRANT_ANALYSIS_PILOT_AS_OF = "2026-07-15T00:00:00+09:00";
export const GRANT_ANALYSIS_PILOT_OBSERVED_AT = "2026-07-14T22:34:50.957Z";

export interface FrozenGrantAnalysisPilotEntry {
  source: "kstartup" | "bizinfo";
  sourceId: string;
  title: string;
  status: "open" | "unknown";
  applyEnd: string | null;
  sourceRevision: string;
  stratum: string;
  includeInOpenMatchKpi: boolean;
}

/**
 * 2026-07-15 KST의 제품 active/canonical universe 1,720건에서 동결한 12건.
 * 위 5건은 사용자가 보고 있던 결과 상단, 나머지는 source/첨부/추출상태 대조군이다.
 */
export const FROZEN_GRANT_ANALYSIS_PILOT_COHORT = [
  {
    source: "kstartup",
    sourceId: "178387",
    title: "2026 글로벌 스타트업 서밋(일본) 참여기업 모집",
    status: "open",
    applyEnd: "2026-07-15",
    sourceRevision: "a862e1b58b4149e07275e629fc06d13cef2ab4c97d9a99feffafd40dbf26ea0f",
    stratum: "visible_top5",
    includeInOpenMatchKpi: true,
  },
  {
    source: "kstartup",
    sourceId: "177947",
    title: "2026년 글로벌기업 협업프로그램(시범) 창업기업 모집",
    status: "open",
    applyEnd: "2026-07-15",
    sourceRevision: "0604d56e48082be09d8de23505f17033ca712733d35821b22ff363344564df3b",
    stratum: "visible_top5",
    includeInOpenMatchKpi: true,
  },
  {
    source: "kstartup",
    sourceId: "178161",
    title: "2026 컴업스타즈 참가기업 모집",
    status: "open",
    applyEnd: "2026-07-16",
    sourceRevision: "d13af4457a31fb705508a100fea7557531ebc99dff8eba9af8d629295230a736",
    stratum: "visible_top5",
    includeInOpenMatchKpi: true,
  },
  {
    source: "kstartup",
    sourceId: "178153",
    title: "2026년 하반기 특허정보검색 및 전자출원 무료 교육 수요조사 안내",
    status: "open",
    applyEnd: "2026-07-17",
    sourceRevision: "53db20bd190ffbdd04774d8a8ab1190a34b5b67977f5c351829aa6975ba5364b",
    stratum: "visible_top5",
    includeInOpenMatchKpi: true,
  },
  {
    source: "kstartup",
    sourceId: "178431",
    title: "2026 SVC Seoul Membership(Global) Recruitment Announcement",
    status: "open",
    applyEnd: "2026-07-20",
    sourceRevision: "056fd5641f6974325a582ea170f8e749d1a710133e3926d42a64f9a2c85ae271",
    stratum: "visible_top5",
    includeInOpenMatchKpi: true,
  },
  {
    source: "kstartup",
    sourceId: "178428",
    title: "2026 지역실증형 오픈이노베이션",
    status: "open",
    applyEnd: "2026-07-31",
    sourceRevision: "bbb66edfe8713721b3428608be3d7045f6d451363bc0c6b9617f1b7aae838372",
    stratum: "kstartup_attachment_failure",
    includeInOpenMatchKpi: true,
  },
  {
    source: "bizinfo",
    sourceId: "PBLN_000000000124200",
    title: "2026년 콘텐츠 해외 투자유치 지원 프로그램 U-KNOCK 2026 in USA 참가기업 모집 공고",
    status: "open",
    applyEnd: "2026-07-29",
    sourceRevision: "32c56ae32af9ab45e8141ccf2684889716445c0a6a9b61be4dcf81414ca695fe",
    stratum: "unstructured_attachment_incomplete",
    includeInOpenMatchKpi: true,
  },
  {
    source: "bizinfo",
    sourceId: "PBLN_000000000120556",
    title: "[충북] 2026년 2분기 청년 소상공인 창업응원금 지원 참여자 모집 공고",
    status: "unknown",
    applyEnd: null,
    sourceRevision: "34a6aad338caf8c4343c26c9ae97600b4997e2c0952dd6a79022097cfe99220c",
    stratum: "unstructured_attachment_complete",
    includeInOpenMatchKpi: false,
  },
  {
    source: "bizinfo",
    sourceId: "PBLN_000000000123931",
    title: "[부산] 아시아 창업엑스포(FLY ASIA 2026) 글로벌 스케일업 지원 사업 글로벌 스케일업 챔피언스 어워즈 참가기업 모집 공고",
    status: "open",
    applyEnd: "2026-07-31",
    sourceRevision: "123f7c60f1cbfabb9045a4335c1279a767945ced73e4050d0f05eeb7546230a5",
    stratum: "text_only_attachment_incomplete",
    includeInOpenMatchKpi: true,
  },
  {
    source: "bizinfo",
    sourceId: "PBLN_000000000118189",
    title: "[전남] 2026년 해외박람회 개별 참가 지원사업 모집 공고",
    status: "open",
    applyEnd: "2026-12-31",
    sourceRevision: "e378da29f4bce3af27bf76d1f550769e22a3744849dc2a12e94121c3c40e264f",
    stratum: "text_only_attachment_complete",
    includeInOpenMatchKpi: true,
  },
  {
    source: "bizinfo",
    sourceId: "PBLN_000000000124290",
    title: "[충북] 충주시 2026년 2차 청년소상공인 창업 지원사업 변경 공고",
    status: "open",
    applyEnd: "2026-07-20",
    sourceRevision: "ef6f36631f8089225a9443b96d1ff3d1a6b1c7967126f66f940485760ecc7920",
    stratum: "structured_control",
    includeInOpenMatchKpi: true,
  },
  {
    source: "bizinfo",
    sourceId: "PBLN_000000000122623",
    title: "[전북] 2026년 2차 자동차 대체부품 분야 기업지원 사업 공고",
    status: "unknown",
    applyEnd: null,
    sourceRevision: "102e1579c6cab7c4efce56d2a53f04fa6ff2b9348566e53d5c625b477c89a2a2",
    stratum: "structured_multi_axis_control",
    includeInOpenMatchKpi: false,
  },
] as const satisfies readonly FrozenGrantAnalysisPilotEntry[];

export function frozenGrantAnalysisPilotKey(entry: Pick<FrozenGrantAnalysisPilotEntry, "source" | "sourceId">): string {
  return `${entry.source}:${entry.sourceId}`;
}

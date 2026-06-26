import {
  normalizeBizInfoLlmCriteria,
  normalizeBizInfoProgram,
  type BizInfoProgram,
} from "@cunote/core";

export function buildBizInfoSampleEntries(options: {
  asOf?: Date;
  collectedAt?: Date;
} = {}) {
  const program: BizInfoProgram = {
    pblancId: "PBLN_SAMPLE",
    pblancNm: "기업마당 테스트 지원사업",
    trgetNm: "중소기업",
    jrsdInsttNm: "중소벤처기업부",
    excInsttNm: "창업진흥원",
    pldirSportRealmLclasCodeNm: "기술",
    pldirSportRealmMlsfcCodeNm: "사업화",
    reqstBeginEndDe: "2026-06-01 ~ 2026-07-20",
    reqstMthPapersCn: "온라인 접수",
    bsnsSumryCn: "<p>경기도 소재 ICT 중소기업의 SaaS 전환을 지원</p>",
    hashtags: "ICT,SaaS,AI",
    pblancUrl: "/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_SAMPLE",
  };

  const criteria = normalizeBizInfoLlmCriteria({
    criteria: [{
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["41"], labels: ["경기"], nationwide: false },
      confidence: 0.9,
      source_span: "경기도 소재 ICT 중소기업",
    }, {
      dimension: "industry",
      operator: "in",
      kind: "required",
      value: { tags: ["ICT", "SaaS"] },
      confidence: 0.82,
      source_span: "ICT 중소기업의 SaaS 전환",
    }, {
      dimension: "size",
      operator: "in",
      kind: "required",
      value: { sizes: ["중소"] },
      confidence: 0.85,
      source_span: "중소기업",
    }],
  }, program.pblancId);

  return [normalizeBizInfoProgram(program, criteria, {
    ...(options.asOf ? { asOf: options.asOf } : {}),
    ...(options.collectedAt ? { collectedAt: options.collectedAt } : {}),
    model: "sample-fixture",
  })];
}

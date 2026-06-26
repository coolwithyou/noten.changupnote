export type BizInfoKind = "program" | "event";

export interface BizInfoProgram {
  trgetNm?: string | null;
  updtPnttm?: string | null;
  hashtags?: string | null;
  inqireCo?: number | string | null;
  creatPnttm?: string | null;
  pblancNm?: string | null;
  pblancId: string;
  printFlpthNm?: string | null;
  refrncNm?: string | null;
  rceptEngnHmpgUrl?: string | null;
  fileNm?: string | null;
  pblancUrl?: string | null;
  jrsdInsttNm?: string | null;
  excInsttNm?: string | null;
  totCnt?: number | string | null;
  reqstMthPapersCn?: string | null;
  pldirSportRealmLclasCodeNm?: string | null;
  reqstBeginEndDe?: string | null;
  flpthNm?: string | null;
  bsnsSumryCn?: string | null;
  pldirSportRealmMlsfcCodeNm?: string | null;
  printFileNm?: string | null;
}

export interface BizInfoEvent {
  orginlUrlAdres?: string | null;
  updtPnttm?: string | null;
  hashtags?: string | null;
  inqireCo?: number | string | null;
  nttNm?: string | null;
  registDe?: string | null;
  printFlpthNm?: string | null;
  eventBeginEndDe?: string | null;
  totCnt?: number | string | null;
  rceptPd?: string | null;
  pldirSportRealmLclasCodeNm?: string | null;
  areaNm?: string | null;
  eventInfoTyNm?: string | null;
  originEngnNm?: string | null;
  eventInfoId: string;
  bizinfoUrl?: string | null;
  nttCn?: string | null;
  printFileNm?: string | null;
}

export interface BizInfoApiResponse<T> {
  jsonArray: T[];
}

export interface BizInfoFetchOptions {
  serviceKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface BizInfoAttachmentMarkdown {
  filename: string;
  markdown: string;
  source_uri?: string;
}

export interface BizInfoExtractionBlock {
  label: string;
  source: "api_field" | "attachment_markdown";
  source_field?: keyof BizInfoProgram;
  filename?: string;
  text: string;
}

export interface BizInfoProgramExtractionInput {
  source: "bizinfo";
  source_id: string;
  title: string;
  url: string | null;
  metadata: {
    target: string | null;
    jurisdiction_agency: string | null;
    operating_agency: string | null;
    category_l1: string | null;
    category_l2: string | null;
    apply_period: string | null;
    application_method: string | null;
    hashtags: string[];
    attachments: Array<{
      filename: string;
      url: string | null;
    }>;
  };
  blocks: BizInfoExtractionBlock[];
  text: string;
}

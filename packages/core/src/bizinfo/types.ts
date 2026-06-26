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

export type PopbillEnvironment = "test" | "production";

export interface PopbillCredentials {
  linkId: string;
  secretKey: string;
  corpNum: string;
  userId?: string;
  isTest: boolean;
  ipRestrictOnOff: boolean;
  useStaticIp: boolean;
  useLocalTimeYn: boolean;
}

export interface PopbillApiEndpoint {
  environment: PopbillEnvironment;
  baseUrl: string;
  serviceId: string;
}

export interface PopbillBizCheckInfo {
  result?: number | string | null;
  resultMessage?: string | null;
  checkDT?: string | null;
  corpNum?: string | null;
  corpName?: string | null;
  CEOName?: string | null;
  personCorpCode?: string | number | null;
  corpScaleCode?: string | number | null;
  industryCode?: string | null;
  bizClass?: string | null;
  bizType?: string | null;
  establishDate?: string | null;
  establishCode?: string | number | null;
  headOfficeCode?: string | number | null;
  workPlaceCode?: string | number | null;
  addr?: string | null;
  addrDetail?: string | null;
  zipCode?: string | null;
  addrCode?: string | number | null;
  closeDownState?: string | number | null;
  closeDownStateDate?: string | null;
  closeDownTaxType?: string | number | null;
  closeDownTaxTypeDate?: string | null;
  [key: string]: unknown;
}

export interface PopbillEnvConfig {
  credentials: PopbillCredentials;
  checkCorpNum: string;
  endpoint: PopbillApiEndpoint;
}

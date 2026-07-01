import type { LiveCompanyMatchReport } from "@cunote/core/matching/live-company-match";

export type LiveMatchReport = LiveCompanyMatchReport;

export interface LiveMatchFormState {
  bizNo: string;
  kstartupLimit: number;
  bizinfoLimit: number;
  bizinfoLlm: boolean;
}

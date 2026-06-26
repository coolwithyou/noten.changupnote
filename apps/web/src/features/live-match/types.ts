import type { LiveCompanyMatchReport } from "@cunote/core";

export type LiveMatchReport = LiveCompanyMatchReport;

export interface LiveMatchFormState {
  bizNo: string;
  kstartupLimit: number;
  bizinfoLimit: number;
  bizinfoLlm: boolean;
}

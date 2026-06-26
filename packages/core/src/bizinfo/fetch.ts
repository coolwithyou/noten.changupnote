import {
  BIZINFO_EVENT_API_ENDPOINT,
  BIZINFO_PROGRAM_API_ENDPOINT,
} from "./constants.js";
import type {
  BizInfoApiResponse,
  BizInfoEvent,
  BizInfoFetchOptions,
  BizInfoKind,
  BizInfoProgram,
} from "./types.js";

type BizInfoRowByKind<TKind extends BizInfoKind> = TKind extends "program"
  ? BizInfoProgram
  : BizInfoEvent;

export async function fetchBizInfoPrograms(
  options: BizInfoFetchOptions,
): Promise<BizInfoApiResponse<BizInfoProgram>> {
  const endpoint = options.endpoint ?? BIZINFO_PROGRAM_API_ENDPOINT;
  const payload = await fetchBizInfoJson(endpoint, options);
  return assertBizInfoApiResponse(payload, "program");
}

export async function fetchBizInfoEvents(
  options: BizInfoFetchOptions,
): Promise<BizInfoApiResponse<BizInfoEvent>> {
  const endpoint = options.endpoint ?? BIZINFO_EVENT_API_ENDPOINT;
  const payload = await fetchBizInfoJson(endpoint, options);
  return assertBizInfoApiResponse(payload, "event");
}

export function buildBizInfoUrl(endpoint: string, serviceKey: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("crtfcKey", serviceKey);
  url.searchParams.set("dataType", "json");
  return url.toString();
}

export function assertBizInfoApiResponse<TKind extends BizInfoKind>(
  payload: unknown,
  kind: TKind,
): BizInfoApiResponse<BizInfoRowByKind<TKind>> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Bizinfo response is not an object");
  }
  const candidate = payload as Partial<BizInfoApiResponse<unknown>>;
  if (!Array.isArray(candidate.jsonArray)) {
    throw new Error("Bizinfo response missing jsonArray[]");
  }

  for (const [index, row] of candidate.jsonArray.entries()) {
    if (!row || typeof row !== "object") {
      throw new Error(`Bizinfo ${kind} row ${index} is not an object`);
    }
    const typedRow = row as Partial<BizInfoProgram & BizInfoEvent>;
    const id = kind === "program" ? typedRow.pblancId : typedRow.eventInfoId;
    if (!id) {
      const idField = kind === "program" ? "pblancId" : "eventInfoId";
      throw new Error(`Bizinfo ${kind} row ${index} missing ${idField}`);
    }
  }

  return { jsonArray: candidate.jsonArray as BizInfoRowByKind<TKind>[] };
}

async function fetchBizInfoJson(endpoint: string, options: BizInfoFetchOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestInit: RequestInit = {
    method: "GET",
    headers: { accept: "application/json" },
  };
  if (options.signal) requestInit.signal = options.signal;

  const response = await fetchImpl(buildBizInfoUrl(endpoint, options.serviceKey), requestInit);
  if (!response.ok) {
    throw new Error(`Bizinfo request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

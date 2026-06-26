import { KSTARTUP_API_ENDPOINT } from "./constants.js";
import type {
  KStartupAnnouncement,
  KStartupApiResponse,
  KStartupFetchManyOptions,
  KStartupFetchPageOptions,
} from "./types.js";

export async function fetchKStartupPage(
  options: KStartupFetchPageOptions,
): Promise<KStartupApiResponse> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 100;
  const endpoint = options.endpoint ?? KSTARTUP_API_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildKStartupUrl(endpoint, options.serviceKey, page, perPage);
  const requestInit: RequestInit = {
    method: "GET",
    headers: { accept: "application/json" },
  };
  if (options.signal) requestInit.signal = options.signal;
  const response = await fetchImpl(url, requestInit);

  if (!response.ok) {
    throw new Error(`K-Startup request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return assertKStartupApiResponse(payload);
}

export async function fetchKStartupPages(
  options: KStartupFetchManyOptions,
): Promise<KStartupAnnouncement[]> {
  const pages = options.pages ?? 1;
  const rows: KStartupAnnouncement[] = [];
  for (let page = options.page ?? 1; page < (options.page ?? 1) + pages; page += 1) {
    const payload = await fetchKStartupPage({ ...options, page });
    rows.push(...payload.data);
  }
  return rows;
}

export function buildKStartupUrl(
  endpoint: string,
  serviceKey: string,
  page: number,
  perPage: number,
): string {
  const params = new URLSearchParams({
    page: String(page),
    perPage: String(perPage),
    returnType: "json",
  });
  const separator = endpoint.includes("?") ? "&" : "?";
  const encodedServiceKey = /%[0-9a-f]{2}/i.test(serviceKey)
    ? serviceKey
    : encodeURIComponent(serviceKey);
  return `${endpoint}${separator}serviceKey=${encodedServiceKey}&${params.toString()}`;
}

export function assertKStartupApiResponse(payload: unknown): KStartupApiResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("K-Startup response is not an object");
  }

  const candidate = payload as Partial<KStartupApiResponse>;
  if (!Array.isArray(candidate.data)) {
    throw new Error("K-Startup response missing data[]");
  }

  for (const [index, row] of candidate.data.entries()) {
    if (!row || typeof row !== "object") {
      throw new Error(`K-Startup row ${index} is not an object`);
    }
    const announcement = row as Partial<KStartupAnnouncement>;
    if (announcement.pbanc_sn === undefined || announcement.pbanc_sn === null) {
      throw new Error(`K-Startup row ${index} missing pbanc_sn`);
    }
  }

  const result: KStartupApiResponse = {
    data: candidate.data,
  };
  if (candidate.totalCount !== undefined) result.totalCount = candidate.totalCount;
  if (candidate.matchCount !== undefined) result.matchCount = candidate.matchCount;
  if (candidate.page !== undefined) result.page = candidate.page;
  if (candidate.perPage !== undefined) result.perPage = candidate.perPage;
  if (candidate.currentCount !== undefined) result.currentCount = candidate.currentCount;
  return result;
}

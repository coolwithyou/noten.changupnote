export const MOEF_SUBSIDY_ANNOUNCEMENT_ENDPOINT =
  "https://apis.data.go.kr/1051000/MoefOpenAPI2025/T_OPD_ASBS_PBNS_UNITY";

export interface MoefSubsidyAnnouncement {
  businessYear: string;
  detailBusinessId: string | null;
  subDetailBusinessId: string | null;
  detailBusinessName: string | null;
  subDetailBusinessName: string | null;
  jurisdictionName: string | null;
  operatorName: string | null;
  announcementName: string;
  announcementStartDate: string | null;
  announcementEndDate: string | null;
  applicationStartDate: string | null;
  applicationEndDate: string | null;
  applicationPeriod: string | null;
  applicationMethod: string | null;
  supportTarget: string | null;
  exclusionTarget: string | null;
  supportDescription: string | null;
  supportCondition: string | null;
  selectionCriteria: string | null;
  requiredDocuments: string | null;
  announcementUrl: string | null;
  updatedAt: string | null;
}

export interface MoefSubsidyAnnouncementPage {
  items: MoefSubsidyAnnouncement[];
  pageNo: number;
  numOfRows: number;
  totalCount: number;
}

export interface FetchMoefSubsidyAnnouncementPageOptions {
  serviceKey: string;
  businessYear: number;
  pageNo?: number;
  numOfRows?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function fetchMoefSubsidyAnnouncementPage(
  options: FetchMoefSubsidyAnnouncementPageOptions,
): Promise<MoefSubsidyAnnouncementPage> {
  const pageNo = boundedInteger(options.pageNo ?? 1, "pageNo", 1, 1_000_000);
  const numOfRows = boundedInteger(options.numOfRows ?? 100, "numOfRows", 1, 999);
  const businessYear = boundedInteger(options.businessYear, "businessYear", 2000, 2100);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestInit: RequestInit = { method: "GET", headers: { accept: "application/json" } };
  if (options.signal) requestInit.signal = options.signal;
  const response = await fetchImpl(buildMoefSubsidyAnnouncementUrl(
    options.endpoint ?? MOEF_SUBSIDY_ANNOUNCEMENT_ENDPOINT,
    options.serviceKey,
    businessYear,
    pageNo,
    numOfRows,
  ), requestInit);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`MOEF subsidy request failed: ${response.status} ${response.statusText} (${safeErrorMessage(bodyText)})`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`MOEF subsidy response is not JSON (${safeErrorMessage(bodyText)})`);
  }
  return parseMoefSubsidyAnnouncementResponse(payload);
}

export function buildMoefSubsidyAnnouncementUrl(
  endpoint: string,
  serviceKey: string,
  businessYear: number,
  pageNo: number,
  numOfRows: number,
): string {
  const params = new URLSearchParams({
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
    resultType: "json",
    bsnsyear: String(businessYear),
  });
  const encodedKey = /%[0-9a-f]{2}/i.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
  return `${endpoint}?serviceKey=${encodedKey}&${params.toString()}`;
}

export function parseMoefSubsidyAnnouncementResponse(payload: unknown): MoefSubsidyAnnouncementPage {
  const root = record(payload, "MOEF response");
  const response = isRecord(root.response) ? root.response : root;
  const header = isRecord(response.header) ? response.header : {};
  const resultCode = stringValue(header.resultCode ?? response.resultCode);
  if (resultCode && resultCode !== "00" && resultCode !== "0") {
    throw new Error(`MOEF API error ${resultCode}: ${stringValue(header.resultMsg ?? response.resultMsg) ?? "unknown"}`);
  }
  const body = isRecord(response.body) ? response.body : response;
  const itemsContainer = isRecord(body.items) ? body.items : body;
  const rawItem = itemsContainer.item;
  const rawItems = Array.isArray(rawItem) ? rawItem : rawItem ? [rawItem] : [];
  const items = rawItems.map((item, index): MoefSubsidyAnnouncement => {
    const row = record(item, `MOEF item ${index}`);
    return {
      businessYear: requiredString(row.BSNSYEAR, `MOEF item ${index}.BSNSYEAR`),
      detailBusinessId: nullableString(row.DTLBZ_ID),
      subDetailBusinessId: nullableString(row.DDTLBZ_ID),
      detailBusinessName: nullableString(row.DTLBZ_NM),
      subDetailBusinessName: nullableString(row.DDTLBZ_NM),
      jurisdictionName: nullableString(row.JRSD_NM),
      operatorName: nullableString(row.DLVPL_NM),
      announcementName: requiredString(row.PBLANC_NM, `MOEF item ${index}.PBLANC_NM`),
      announcementStartDate: nullableString(row.PBLANC_BEGIN_DE),
      announcementEndDate: nullableString(row.PBLANC_END_DE),
      applicationStartDate: nullableString(row.RCEPT_BEGIN_DE),
      applicationEndDate: nullableString(row.RCEPT_END_DE),
      applicationPeriod: nullableString(row.RCEPT_PD_DC),
      applicationMethod: nullableString(row.REQST_RCEPT_MTH_CN),
      supportTarget: nullableString(row.SPORT_TRGET_CN),
      exclusionTarget: nullableString(row.EXCL_TRGET_CN),
      supportDescription: nullableString(row.SPORT_CN_DC),
      supportCondition: nullableString(row.SPORT_CND_CN),
      selectionCriteria: nullableString(row.SLCTN_STDR_DC),
      requiredDocuments: nullableString(row.PRESENTN_PAPERS_GUIDANCE_CN),
      announcementUrl: nullableString(row.PBLANC_POPUP_URL) ?? nullableString(row.BSNS_GUIDANCE_URL),
      updatedAt: nullableString(row.PBLANC_UPDT_DT),
    };
  });
  return {
    items,
    pageNo: nonNegativeInteger(body.pageNo, 1),
    numOfRows: nonNegativeInteger(body.numOfRows, items.length),
    totalCount: nonNegativeInteger(body.totalCount, items.length),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown, label: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`${label} is required`);
  return parsed;
}
function nullableString(value: unknown): string | null {
  return stringValue(value) ?? null;
}
function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}
function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function safeErrorMessage(value: string): string {
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || "empty response").slice(0, 240);
}

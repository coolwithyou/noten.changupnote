export const MSIT_ANNOUNCEMENT_ENDPOINT =
  "https://apis.data.go.kr/1721000/msitannouncementinfo/businessAnnouncMentList";

export interface MsitAnnouncement {
  subject: string;
  viewUrl: string;
  deptName?: string | null;
  managerName?: string | null;
  managerTel?: string | null;
  pressDt: string;
  fileName?: string | null;
  fileUrl?: string | null;
}

export interface MsitAnnouncementPage {
  items: MsitAnnouncement[];
  pageNo: number;
  numOfRows: number;
  totalCount: number;
}

export interface FetchMsitAnnouncementPageOptions {
  serviceKey: string;
  pageNo?: number;
  numOfRows?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchMsitAnnouncementSnapshotOptions extends Omit<FetchMsitAnnouncementPageOptions, "pageNo"> {
  maxPages?: number;
}

export interface MsitAnnouncementSnapshot {
  items: MsitAnnouncement[];
  totalCount: number;
  fetchedPages: number;
  complete: boolean;
}

export async function fetchMsitAnnouncementSnapshot(
  options: FetchMsitAnnouncementSnapshotOptions,
): Promise<MsitAnnouncementSnapshot> {
  const numOfRows = boundedInteger(options.numOfRows ?? 100, "numOfRows", 1, 1_000);
  const maxPages = boundedInteger(options.maxPages ?? 100, "maxPages", 1, 1_000);
  const items: MsitAnnouncement[] = [];
  let totalCount = 0;
  let fetchedPages = 0;
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await fetchMsitAnnouncementPage({ ...options, pageNo, numOfRows });
    fetchedPages += 1;
    totalCount = Math.max(totalCount, page.totalCount);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= totalCount) break;
  }
  return { items, totalCount, fetchedPages, complete: items.length >= totalCount };
}

export async function fetchMsitAnnouncementPage(options: FetchMsitAnnouncementPageOptions): Promise<MsitAnnouncementPage> {
  const pageNo = options.pageNo ?? 1;
  const numOfRows = options.numOfRows ?? 100;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestInit: RequestInit = { method: "GET", headers: { accept: "application/json" } };
  if (options.signal) requestInit.signal = options.signal;
  const response = await fetchImpl(buildMsitAnnouncementUrl(
    options.endpoint ?? MSIT_ANNOUNCEMENT_ENDPOINT,
    options.serviceKey,
    pageNo,
    numOfRows,
  ), requestInit);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`MSIT announcement request failed: ${response.status} ${response.statusText} (${safeErrorMessage(bodyText)})`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`MSIT announcement response is not JSON (${safeErrorMessage(bodyText)})`);
  }
  return parseMsitAnnouncementResponse(payload);
}

export function buildMsitAnnouncementUrl(endpoint: string, serviceKey: string, pageNo: number, numOfRows: number): string {
  const params = new URLSearchParams({ pageNo: String(pageNo), numOfRows: String(numOfRows), returnType: "json" });
  const encodedKey = /%[0-9a-f]{2}/i.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
  return `${endpoint}?ServiceKey=${encodedKey}&${params.toString()}`;
}

export function parseMsitAnnouncementResponse(payload: unknown): MsitAnnouncementPage {
  const root = record(payload, "MSIT response");
  const response = isRecord(root.response) ? root.response : root;
  const header = isRecord(response.header) ? response.header : {};
  const resultCode = stringValue(header.resultCode ?? response.resultCode);
  if (resultCode && resultCode !== "00" && resultCode !== "0") {
    throw new Error(`MSIT API error ${resultCode}: ${stringValue(header.resultMsg ?? response.resultMsg) ?? "unknown"}`);
  }
  const body = isRecord(response.body) ? response.body : response;
  const itemsContainer = isRecord(body.items) ? body.items : body;
  const rawItems = Array.isArray(itemsContainer.item)
    ? itemsContainer.item
    : Array.isArray(body.items)
      ? body.items
      : itemsContainer.item
        ? [itemsContainer.item]
        : [];
  const items = rawItems.map((item, index): MsitAnnouncement => {
    const row = record(item, `MSIT item ${index}`);
    return {
      subject: requiredString(row.subject, `MSIT item ${index}.subject`),
      viewUrl: requiredString(row.viewUrl, `MSIT item ${index}.viewUrl`),
      pressDt: requiredString(row.pressDt, `MSIT item ${index}.pressDt`),
      deptName: nullableString(row.deptName),
      managerName: nullableString(row.managerName),
      managerTel: nullableString(row.managerTel),
      fileName: nullableString(row.fileName),
      fileUrl: nullableString(row.fileUrl),
    };
  });
  return {
    items,
    pageNo: integer(body.pageNo, 1),
    numOfRows: integer(body.numOfRows, items.length),
    totalCount: integer(body.totalCount, items.length),
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
function integer(value: unknown, fallback: number): number {
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

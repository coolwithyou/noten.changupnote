/** KIPRISPlus 특허·실용/디자인/상표 출원인 exact 권리 이력 조회. */

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_DOCS = 500;

export type KiprisRightKind = "patent_utility" | "design" | "trademark";

export interface KiprisRightSummary {
  kind: KiprisRightKind;
  totalCount: number;
  /** 출원인 검색 전체 건수. */
  appliedCount: number;
  fetchedCount: number;
  publishedCount: number;
  registeredCount: number;
  extinguishedCount: number;
  truncated: boolean;
}

export interface KiprisRightsSummary {
  patentUtility: KiprisRightSummary;
  design: KiprisRightSummary;
  trademark: KiprisRightSummary;
  totalCount: number;
  truncated: boolean;
}

export interface CheckKiprisRightsInput {
  accessKey: string;
  applicantNumber: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class KiprisRightsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "KiprisRightsError";
  }
}

interface RightEndpoint {
  kind: KiprisRightKind;
  url: string;
  applicantParam: string;
  pageParam: string;
  totalTags: readonly string[];
  itemTag: string;
  statusTags: readonly string[];
  publishedTags: readonly string[];
  registeredTags: readonly string[];
  extraParams?: Readonly<Record<string, string>>;
}

const ENDPOINTS: readonly RightEndpoint[] = [
  {
    kind: "patent_utility",
    url: "https://plus.kipris.or.kr/openapi/rest/patUtiModInfoSearchSevice/applicantNameSearchInfo",
    applicantParam: "applicant",
    pageParam: "docsStart",
    totalTags: ["totalSearchCount"],
    itemTag: "PatentUtilityInfo",
    statusTags: ["RegistrationStatus"],
    publishedTags: ["OpeningNumber", "OpeningDate", "PublicNumber", "PublicDate"],
    registeredTags: ["RegistrationNumber", "RegistrationDate"],
    extraParams: { patent: "true", utility: "true" },
  },
  {
    kind: "design",
    url: "https://plus.kipris.or.kr/openapi/rest/designInfoSearchService/applicantNameSearchInfo",
    applicantParam: "applicantName",
    pageParam: "startNumber",
    totalTags: ["totalCount"],
    itemTag: "DesignInfo",
    statusTags: ["applicationStatus"],
    publishedTags: ["publicationNumber", "publicationDate", "openNumber", "openDate"],
    registeredTags: ["registrationNumber", "registrationDate"],
  },
  {
    kind: "trademark",
    url: "https://plus.kipris.or.kr/openapi/rest/trademarkInfoSearchService/applicantNamesearchInfo",
    applicantParam: "applicantName",
    pageParam: "docsStart",
    totalTags: ["TotalSearchCount"],
    itemTag: "TradeMarkInfo",
    statusTags: ["ApplicationStatus"],
    publishedTags: ["PublicNumber", "PublicDate", "RegistrationPublicNumber", "RegistrationPublicDate"],
    registeredTags: ["RegistrationNumber", "RegistrationDate"],
  },
];

export async function checkKiprisRights(input: CheckKiprisRightsInput): Promise<KiprisRightsSummary> {
  const accessKey = input.accessKey.trim();
  if (!accessKey) throw new KiprisRightsError("KIPRIS accessKey가 없습니다.");
  const applicantNumber = input.applicantNumber.replace(/\D/g, "");
  if (!applicantNumber) throw new KiprisRightsError("KIPRIS 특허고객번호가 없습니다.");

  const summaries = await Promise.all(
    ENDPOINTS.map((endpoint) => checkRightEndpoint({
      endpoint,
      accessKey,
      applicantNumber,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: input.fetchImpl ?? fetch,
    })),
  );
  const byKind = new Map(summaries.map((summary) => [summary.kind, summary]));
  const patentUtility = requiredSummary(byKind, "patent_utility");
  const design = requiredSummary(byKind, "design");
  const trademark = requiredSummary(byKind, "trademark");
  return {
    patentUtility,
    design,
    trademark,
    totalCount: patentUtility.totalCount + design.totalCount + trademark.totalCount,
    truncated: patentUtility.truncated || design.truncated || trademark.truncated,
  };
}

export function parseKiprisRightSummary(xml: string, kind: KiprisRightKind): KiprisRightSummary {
  const endpoint = ENDPOINTS.find((candidate) => candidate.kind === kind);
  if (!endpoint) throw new KiprisRightsError(`지원하지 않는 KIPRIS 권리 종류: ${kind}`);
  const resultCode = extractTag(xml, "resultCode");
  if (resultCode && !["00", "0"].includes(resultCode)) {
    const message = extractTag(xml, "resultMsg");
    throw new KiprisRightsError(
      `KIPRIS ${kind} resultCode=${resultCode}${message ? ` (${message})` : ""}`,
    );
  }

  const items = extractBlocks(xml, endpoint.itemTag);
  const totalCount = integerFromTags(xml, endpoint.totalTags) ?? items.length;
  let publishedCount = 0;
  let registeredCount = 0;
  let extinguishedCount = 0;
  for (const item of items) {
    const statuses = endpoint.statusTags.map((tag) => extractTag(item, tag) ?? "").join(" ");
    if (endpoint.publishedTags.some((tag) => Boolean(extractTag(item, tag)))) publishedCount += 1;
    if (endpoint.registeredTags.some((tag) => Boolean(extractTag(item, tag)))) registeredCount += 1;
    if (/소멸|만료|expiration|extinguish/i.test(statuses)) extinguishedCount += 1;
  }
  return {
    kind,
    totalCount,
    appliedCount: totalCount,
    fetchedCount: items.length,
    publishedCount,
    registeredCount,
    extinguishedCount,
    truncated: totalCount > items.length,
  };
}

export function buildKiprisRightUrl(
  kind: KiprisRightKind,
  accessKey: string,
  applicantNumber: string,
): string {
  const endpoint = ENDPOINTS.find((candidate) => candidate.kind === kind);
  if (!endpoint) throw new KiprisRightsError(`지원하지 않는 KIPRIS 권리 종류: ${kind}`);
  const url = new URL(endpoint.url);
  url.searchParams.set(endpoint.applicantParam, applicantNumber.replace(/\D/g, ""));
  url.searchParams.set(endpoint.pageParam, "1");
  url.searchParams.set("docsCount", String(MAX_DOCS));
  for (const [key, value] of Object.entries(endpoint.extraParams ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("accessKey", accessKey);
  return url.toString();
}

async function checkRightEndpoint(input: {
  endpoint: RightEndpoint;
  accessKey: string;
  applicantNumber: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<KiprisRightSummary> {
  const url = buildKiprisRightUrl(input.endpoint.kind, input.accessKey, input.applicantNumber);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      headers: { Accept: "application/xml" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KiprisRightsError(`KIPRIS ${input.endpoint.kind} 응답 시간 초과(${input.timeoutMs}ms)`, error);
    }
    throw new KiprisRightsError(`KIPRIS ${input.endpoint.kind} 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new KiprisRightsError(
      `KIPRIS ${input.endpoint.kind} HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }
  return parseKiprisRightSummary(await response.text(), input.endpoint.kind);
}

function requiredSummary(
  byKind: Map<KiprisRightKind, KiprisRightSummary>,
  kind: KiprisRightKind,
): KiprisRightSummary {
  const summary = byKind.get(kind);
  if (!summary) throw new KiprisRightsError(`KIPRIS ${kind} 요약이 없습니다.`);
  return summary;
}

function extractBlocks(xml: string, tag: string): string[] {
  const escaped = escapeRegExp(tag);
  return [...xml.matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "gi"))]
    .map((match) => match[1] ?? "");
}

function integerFromTags(xml: string, tags: readonly string[]): number | null {
  for (const tag of tags) {
    const value = extractTag(xml, tag);
    if (value !== null) {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
    }
  }
  return null;
}

function extractTag(xml: string, tag: string): string | null {
  const escaped = escapeRegExp(tag);
  const raw = xml.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1];
  if (raw === undefined) return null;
  const value = raw.replace(/<[^>]+>/g, "").trim();
  return value || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * KIPRISPlus 출원인 법인 REST API — 사업자등록번호 exact 조회.
 *
 * 공식 오퍼레이션:
 * GET https://plus.kipris.or.kr/openapi/rest/CorpBsApplicantService/corpBsApplicantInfoV3
 *   ?BusinessRegistrationNumber=000-00-00000&accessKey=...
 *
 * 이 상품은 공개 또는 등록된 출원 이력이 있는 법인만 제공한다. 따라서 null은
 * "공개·등록 출원인 법인 목록에서 조회되지 않음"이며 미공개 출원까지 포함한 IP 부재 확정이 아니다.
 */

const KIPRIS_APPLICANT_ENDPOINT =
  "https://plus.kipris.or.kr/openapi/rest/CorpBsApplicantService/corpBsApplicantInfoV3";
const DEFAULT_TIMEOUT_MS = 12_000;

export interface KiprisApplicantMatch {
  applicantNumber: string;
  applicantName: string | null;
  corporationNumber: string | null;
  businessRegistrationNumber: string;
}

export interface CheckKiprisApplicantInput {
  accessKey: string;
  bizNo: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class KiprisApplicantError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "KiprisApplicantError";
  }
}

export async function checkKiprisApplicant(
  input: CheckKiprisApplicantInput,
): Promise<KiprisApplicantMatch | null> {
  const bizNo = sanitizeBizNo(input.bizNo);
  if (bizNo.length !== 10) throw new KiprisApplicantError("KIPRIS 사업자번호는 10자리여야 합니다.");
  const accessKey = input.accessKey.trim();
  if (!accessKey) throw new KiprisApplicantError("KIPRIS accessKey가 없습니다.");

  const url = new URL(KIPRIS_APPLICANT_ENDPOINT);
  url.searchParams.set("BusinessRegistrationNumber", formatBizNo(bizNo));
  url.searchParams.set("accessKey", accessKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      headers: { Accept: "application/xml" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KiprisApplicantError(`KIPRIS 응답 시간 초과(${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`, error);
    }
    throw new KiprisApplicantError(`KIPRIS 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new KiprisApplicantError(
      `KIPRIS HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }

  const match = parseKiprisApplicant(await response.text());
  if (match && sanitizeBizNo(match.businessRegistrationNumber) !== bizNo) {
    throw new KiprisApplicantError("KIPRIS 응답 사업자번호가 요청값과 일치하지 않습니다.");
  }
  return match;
}

export function parseKiprisApplicant(xml: string): KiprisApplicantMatch | null {
  const resultCode = extractTag(xml, "resultCode");
  if (resultCode && !["00", "0"].includes(resultCode)) {
    const resultMsg = extractTag(xml, "resultMsg");
    throw new KiprisApplicantError(
      `KIPRIS resultCode=${resultCode}${resultMsg ? ` (${resultMsg})` : ""}`,
    );
  }

  const item = xml.match(/<corpBsApplicantInfo\b[^>]*>([\s\S]*?)<\/corpBsApplicantInfo>/i)?.[1];
  if (!item) return null;
  const applicantNumber = extractTag(item, "ApplicantNumber");
  const businessRegistrationNumber = extractTag(item, "BusinessRegistrationNumber");
  if (!applicantNumber || !businessRegistrationNumber) {
    throw new KiprisApplicantError("KIPRIS 출원인 응답의 필수 필드가 누락됐습니다.");
  }

  return {
    applicantNumber,
    applicantName: extractTag(item, "ApplicantName"),
    corporationNumber: extractTag(item, "CorporationNumber"),
    businessRegistrationNumber,
  };
}

function extractTag(xml: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = xml.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1];
  if (raw === undefined) return null;
  const value = decodeXml(raw.replace(/<[^>]+>/g, "").trim());
  return value || null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function sanitizeBizNo(value: string): string {
  return value.replace(/\D/g, "");
}

function formatBizNo(value: string): string {
  return `${value.slice(0, 3)}-${value.slice(3, 5)}-${value.slice(5)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 공공구매종합정보망(SMPP) 확인서 조회 — 조달청/중기부 공공데이터포털 API.
 *
 * 여성기업확인서(getFnrssList)·장애인기업확인서(getDspsnList)를 조회한다.
 * 팝빌·국세청 어디에도 없는 정보라서 팝빌 결과에 겹쳐 회사 프로필을 보강한다.
 *
 * 엔드포인트: GET http://apis.data.go.kr/B550598/smppCertInfo/{op}
 *   ?serviceKey={key}&bsnmNo=<사업자번호 10자리>&stdrDate=<YYYYMMDD>&numOfRows=5&pageNo=1
 *
 * 응답은 XML(평면 스키마)이라 의존성 없이 관대한 태그 추출(정규식)로 파싱한다.
 *  - 보유:   <resultCode>00</resultCode> + <item>…</item>
 *  - 미보유: <resultCode>90</resultCode> ("매칭데이터가 존재하지 않습니다") — 오류가 아닌 정상 음성 응답.
 *  - 그 외 코드/HTTP 오류/네트워크 실패: throw (호출부가 catch 후 fail-open).
 */

const SMPP_ENDPOINT_BASE = "http://apis.data.go.kr/B550598/smppCertInfo";
const OP_WOMEN = "getFnrssList"; // 여성기업확인
const OP_DISABLED = "getDspsnList"; // 장애인기업확인
const DEFAULT_TIMEOUT_MS = 2_000;

/** 확인서 한 종류의 조회 결과. held=false면 미보유(90), true면 보유(00, item 파싱). */
export interface SmppCertResult {
  /** 확인서 보유 여부(resultCode 00=true, 90=false). */
  held: boolean;
  /** 유효기간 시작일 YYYYMMDD. */
  validPdBeginDe?: string;
  /** 유효기간 종료일 YYYYMMDD. */
  validPdEndDe?: string;
  /** 확인(발급)일자 YYYYMMDD. */
  certfcDe?: string;
  /** 발급기관명. */
  issuInstt?: string;
}

/** 여성/장애인 확인서 조회 결과 묶음. */
export interface SmppCertificates {
  women: SmppCertResult | null;
  disabled: SmppCertResult | null;
}

export interface CheckSmppCertificatesInput {
  /** 공공데이터포털 인증키. 이미 percent-encoding 되어 있을 수 있다. */
  serviceKey: string;
  /** 조회 대상 사업자번호(하이픈/공백 허용, 내부에서 숫자만 추출). */
  bizNo: string;
  /** 기준일자 YYYYMMDD(유효기간 판정 기준). */
  stdrDate: string;
  /** 요청 타임아웃(ms). 기본 2000ms. */
  timeoutMs?: number;
  /** 테스트용 fetch 주입(기본 global fetch). */
  fetchImpl?: typeof fetch;
}

export class SmppCertificateError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SmppCertificateError";
  }
}

/**
 * 여성/장애인 확인서를 병렬 조회한다. 어느 한쪽이라도 오류면 전체가 throw 되어
 * 호출부에서 fail-open으로 다뤄진다(미보유 90은 오류가 아니라 held:false).
 */
export async function checkSmppCertificates(
  input: CheckSmppCertificatesInput,
): Promise<SmppCertificates> {
  const bizNo = sanitizeBizNo(input.bizNo);
  if (bizNo.length !== 10) {
    throw new SmppCertificateError(`Invalid business number for SMPP cert check: ${input.bizNo}`);
  }
  const serviceKey = input.serviceKey?.trim();
  if (!serviceKey) {
    throw new SmppCertificateError("Missing SMPP service key.");
  }
  const stdrDate = (input.stdrDate ?? "").replace(/\D/g, "");
  if (stdrDate.length !== 8) {
    throw new SmppCertificateError(`Invalid stdrDate for SMPP cert check: ${input.stdrDate}`);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const [women, disabled] = await Promise.all([
    fetchSmppCert({ op: OP_WOMEN, serviceKey, bizNo, stdrDate, timeoutMs, fetchImpl }),
    fetchSmppCert({ op: OP_DISABLED, serviceKey, bizNo, stdrDate, timeoutMs, fetchImpl }),
  ]);

  return { women, disabled };
}

async function fetchSmppCert(input: {
  op: string;
  serviceKey: string;
  bizNo: string;
  stdrDate: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<SmppCertResult> {
  const url = buildSmppUrl(input.op, input.serviceKey, input.bizNo, input.stdrDate);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/xml" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new SmppCertificateError(`SMPP ${input.op} request failed: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new SmppCertificateError(`SMPP ${input.op} request returned HTTP ${response.status}`);
  }

  let xml: string;
  try {
    xml = await response.text();
  } catch (error) {
    throw new SmppCertificateError(`SMPP ${input.op} response body read failed: ${errorText(error)}`, error);
  }

  return parseSmppCertXml(xml, input.op);
}

/**
 * SMPP 응답 XML을 SmppCertResult로 파싱한다.
 *  - resultCode 00: held=true + item 필드 추출.
 *  - resultCode 90: held=false(정상 음성 응답).
 *  - 그 외/누락: throw.
 */
export function parseSmppCertXml(xml: string, op = "smpp"): SmppCertResult {
  const resultCode = extractTag(xml, "resultCode");
  if (resultCode === "90") {
    return { held: false };
  }
  if (resultCode !== "00") {
    const message = extractTag(xml, "resultMsg") ?? extractTag(xml, "returnAuthMsg") ?? extractTag(xml, "errMsg");
    throw new SmppCertificateError(
      `SMPP ${op} returned resultCode=${resultCode ?? "(none)"}${message ? ` (${message})` : ""}`,
    );
  }

  // 보유(00): 첫 item 블록에서 필드 추출(item 스코프가 없으면 전체 문서에서 추출).
  const itemBlock = extractTag(xml, "item") ?? xml;
  const result: SmppCertResult = { held: true };
  const validPdBeginDe = extractTag(itemBlock, "validPdBeginDe");
  const validPdEndDe = extractTag(itemBlock, "validPdEndDe");
  const certfcDe = extractTag(itemBlock, "certfcDe");
  const issuInstt = extractTag(itemBlock, "issuInstt");
  if (validPdBeginDe) result.validPdBeginDe = validPdBeginDe;
  if (validPdEndDe) result.validPdEndDe = validPdEndDe;
  if (certfcDe) result.certfcDe = certfcDe;
  if (issuInstt) result.issuInstt = issuInstt;
  return result;
}

/**
 * SMPP 엔드포인트 URL을 만든다. serviceKey가 이미 percent-encoding 된 값이면 그대로
 * 붙이고(이중 인코딩 방지), 원문 키면 encodeURIComponent 한다.
 */
export function buildSmppUrl(op: string, serviceKey: string, bizNo: string, stdrDate: string): string {
  const params = [
    `serviceKey=${encodeServiceKey(serviceKey)}`,
    `bsnmNo=${encodeURIComponent(bizNo)}`,
    `stdrDate=${encodeURIComponent(stdrDate)}`,
    "numOfRows=5",
    "pageNo=1",
  ].join("&");
  return `${SMPP_ENDPOINT_BASE}/${op}?${params}`;
}

function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  const unwrapped = raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1").trim();
  return unwrapped.length > 0 ? unwrapped : undefined;
}

function encodeServiceKey(serviceKey: string): string {
  return /%[0-9A-Fa-f]{2}/.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

function sanitizeBizNo(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

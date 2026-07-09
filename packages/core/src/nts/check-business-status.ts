/**
 * 국세청(NTS) 사업자등록 상태조회 — 공공데이터포털 odcloud API.
 *
 * 무료(무과금) API로, 팝빌 캐시가 살아있는 동안에도 휴·폐업/과세유형 전환을
 * 저비용으로 감지하기 위해 사용한다. 호출부에서 fail-open으로 다뤄야 하므로
 * 실패 시에는 throw 한다(호출부가 catch 후 기존 결과를 유지).
 *
 * 엔드포인트: POST https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey={key}&returnType=JSON
 * 요청 본문:  {"b_no": ["<사업자번호 10자리>"]}
 */

const NTS_STATUS_ENDPOINT = "https://api.odcloud.kr/api/nts-businessman/v1/status";
const DEFAULT_TIMEOUT_MS = 2_000;

/** status API 응답의 data[] 원소 1건. */
export interface NtsBusinessStatusData {
  /** 조회한 사업자번호(10자리, 하이픈 없음). */
  b_no: string;
  /** 납세자 상태(문자열): "계속사업자" | "휴업자" | "폐업자" | "국세청에 등록되지 않은 사업자입니다." */
  b_stt: string;
  /** 납세자 상태코드: "01" 계속사업자 | "02" 휴업자 | "03" 폐업자 | "" 미등록. */
  b_stt_cd: string;
  /** 과세유형 메시지(문자열). */
  tax_type: string;
  /** 과세유형 코드. */
  tax_type_cd: string;
  /** 폐업일자 YYYYMMDD (폐업자일 때). */
  end_dt?: string;
  /** 단위과세전환폐업여부 등. */
  utcc_yn?: string;
  /** 최근 과세유형 전환일자 YYYYMMDD. */
  tax_type_change_dt?: string;
  /** 세금계산서 적용일자 등. */
  invoice_apply_dt?: string;
  /** 직전 과세유형 메시지/코드. */
  rbf_tax_type?: string;
  rbf_tax_type_cd?: string;
}

/** status API 전체 응답 형태. */
export interface NtsStatusResponse {
  status_code?: string;
  request_cnt?: number;
  valid_cnt?: number;
  data?: NtsBusinessStatusData[];
}

export interface CheckNtsBusinessStatusInput {
  /** 공공데이터포털 인증키. 이미 percent-encoding 되어 있을 수 있다. */
  serviceKey: string;
  /** 조회 대상 사업자번호(하이픈/공백 허용, 내부에서 숫자만 추출). */
  bizNo: string;
  /** 요청 타임아웃(ms). 기본 2000ms. */
  timeoutMs?: number;
  /** 테스트용 fetch 주입(기본 global fetch). */
  fetchImpl?: typeof fetch;
}

/** 국세청 상태조회 결과 분류. */
export type NtsBusinessStatusClassification =
  | "active"
  | "suspended"
  | "closed"
  | "not_registered";

/**
 * 국세청 상태조회 응답 1건을 분류한다(순수 함수, 단위 테스트 가능).
 * - "01" 계속사업자 → active
 * - "02" 휴업자     → suspended
 * - "03" 폐업자     → closed
 * - "" 또는 상태 메시지에 "등록되지 않은" 포함 → not_registered
 * 그 외 판정 불가한 상태코드는 보수적으로 active 로 취급한다(팝빌 진행).
 */
export function classifyNtsBusinessStatus(
  data: NtsBusinessStatusData,
): NtsBusinessStatusClassification {
  const code = (data.b_stt_cd ?? "").trim();
  if (code === "01") return "active";
  if (code === "02") return "suspended";
  if (code === "03") return "closed";

  const notRegistered =
    code === "" ||
    /등록되지 않은/.test(data.tax_type ?? "") ||
    /등록되지 않은/.test(data.b_stt ?? "");
  if (notRegistered) return "not_registered";

  return "active";
}

export class NtsBusinessStatusError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NtsBusinessStatusError";
  }
}

/**
 * 국세청 상태조회를 1회 호출하고 data[0]을 반환한다. 실패 시 throw.
 */
export async function checkNtsBusinessStatus(
  input: CheckNtsBusinessStatusInput,
): Promise<NtsBusinessStatusData> {
  const bizNo = sanitizeBizNo(input.bizNo);
  if (bizNo.length !== 10) {
    throw new NtsBusinessStatusError(`Invalid business number for NTS status check: ${input.bizNo}`);
  }
  const serviceKey = input.serviceKey?.trim();
  if (!serviceKey) {
    throw new NtsBusinessStatusError("Missing NTS service key.");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildStatusUrl(serviceKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ b_no: [bizNo] }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new NtsBusinessStatusError(`NTS status request failed: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new NtsBusinessStatusError(`NTS status request returned HTTP ${response.status}`);
  }

  let payload: NtsStatusResponse;
  try {
    payload = (await response.json()) as NtsStatusResponse;
  } catch (error) {
    throw new NtsBusinessStatusError(`NTS status response was not valid JSON: ${errorText(error)}`, error);
  }

  const first = payload.data?.[0];
  if (!first || typeof first.b_no !== "string") {
    throw new NtsBusinessStatusError("NTS status response did not include data[0].");
  }
  return first;
}

/**
 * odcloud status 엔드포인트 URL을 만든다. serviceKey가 이미 percent-encoding 된
 * 값이면 그대로 붙이고(이중 인코딩 방지), 원문 키면 encodeURIComponent 한다.
 */
export function buildStatusUrl(serviceKey: string): string {
  return `${NTS_STATUS_ENDPOINT}?serviceKey=${encodeServiceKey(serviceKey)}&returnType=JSON`;
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

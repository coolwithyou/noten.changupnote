import {
  ANALYSIS_LAB_MAX_BATCH_CONCURRENCY,
  type LabBatchStartRequest,
} from "@/features/dev/analysis-lab/contract";

/** ops/batch POST 본문을 실행 계약으로 변환한다. 오류면 사유 문자열을 반환한다. */
export function parseLabBatchStartRequest(body: unknown): LabBatchStartRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "본문이 JSON 객체가 아닙니다.";
  }
  const record = body as Record<string, unknown>;

  const limit = record.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    return "limit 은 1 이상의 정수여야 합니다.";
  }
  const concurrency = record.concurrency;
  if (
    typeof concurrency !== "number"
    || !Number.isInteger(concurrency)
    || concurrency < 1
    || concurrency > ANALYSIS_LAB_MAX_BATCH_CONCURRENCY
  ) {
    return `concurrency 는 1~${ANALYSIS_LAB_MAX_BATCH_CONCURRENCY} 정수여야 합니다.`;
  }
  if (record.retryErrors !== undefined && typeof record.retryErrors !== "boolean") {
    return "retryErrors 는 boolean 이어야 합니다.";
  }
  if (record.reanalyzeOutdated !== undefined && typeof record.reanalyzeOutdated !== "boolean") {
    return "reanalyzeOutdated 는 boolean 이어야 합니다.";
  }
  if (
    record.withApplicationRoundtrip !== undefined
    && typeof record.withApplicationRoundtrip !== "boolean"
  ) {
    return "withApplicationRoundtrip 는 boolean 이어야 합니다.";
  }
  const withApplicationRoundtrip = record.withApplicationRoundtrip === true;

  let transport: "api" | "claude-cli" | undefined;
  if (record.transport !== undefined) {
    if (record.transport !== "api" && record.transport !== "claude-cli") {
      return `transport 값이 잘못됐습니다: "${String(record.transport)}" — 허용값은 "api" 또는 "claude-cli" 뿐입니다(오타 fail-fast).`;
    }
    transport = record.transport;
  }
  let model: string | undefined;
  if (record.model !== undefined) {
    if (typeof record.model !== "string" || record.model.trim() === "") {
      return "model 은 비어 있지 않은 문자열이어야 합니다.";
    }
    model = record.model.trim();
  }
  let roundtripModel: string | undefined;
  if (record.roundtripModel !== undefined) {
    if (typeof record.roundtripModel !== "string" || record.roundtripModel.trim() === "") {
      return "roundtripModel 은 비어 있지 않은 문자열이어야 합니다.";
    }
    if (!withApplicationRoundtrip) {
      return "roundtripModel 은 withApplicationRoundtrip=true와 함께 지정해야 합니다.";
    }
    roundtripModel = record.roundtripModel.trim();
  }

  return {
    limit,
    concurrency,
    retryErrors: record.retryErrors === true,
    reanalyzeOutdated: record.reanalyzeOutdated === true,
    ...(withApplicationRoundtrip ? { withApplicationRoundtrip: true } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(roundtripModel !== undefined ? { roundtripModel } : {}),
  };
}

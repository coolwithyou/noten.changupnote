import { resolveLabModel } from "../extractor";
import { resolveLabLlmBinding } from "../claude-cli-transport";
import {
  runApplicationRoundtripAnalysis,
  type ApplicationRoundtripAnalysisOptions,
} from "./analyze";

/**
 * 로컬 analysis-lab의 독립 Kordoc 실행도 딥분석 배치와 같은 구독 transport를 쓴다.
 * 공용 analyzer는 운영 API worker도 사용하므로 lab binding을 여기에서만 주입한다.
 */
export async function runLabApplicationRoundtripAnalysis(grantId: string) {
  const binding = await resolveLabLlmBinding();
  return runApplicationRoundtripAnalysis(grantId, buildLabApplicationRoundtripOptions({
    transport: binding.transport,
    apiKey: binding.apiKey,
    ...(binding.fetchImpl ? { fetchImpl: binding.fetchImpl } : {}),
  }));
}

export function buildLabApplicationRoundtripOptions(input: {
  transport: "api" | "claude-cli";
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}): ApplicationRoundtripAnalysisOptions {
  const model = input.model?.trim()
    || process.env.ANALYSIS_LAB_ROUNDTRIP_MODEL?.trim()
    || resolveLabModel();
  const timeoutMs = input.timeoutMs ?? resolveRoundtripTimeoutMs();
  return {
    transport: input.transport,
    apiKey: input.apiKey,
    model,
    timeoutMs,
    candidateConcurrency: input.transport === "claude-cli" ? 1 : 2,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
}

function resolveRoundtripTimeoutMs(): number {
  const raw = process.env.ANALYSIS_LAB_ROUNDTRIP_TIMEOUT_MS?.trim()
    || process.env.ANALYSIS_LAB_TIMEOUT_MS?.trim();
  if (!raw) return 540_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 540_000;
}

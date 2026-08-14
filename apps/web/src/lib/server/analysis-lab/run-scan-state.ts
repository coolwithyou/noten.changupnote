import type { GrantRunState } from "./batch-plan";
import { classifyLabRunOutcome } from "./run-outcome";

/** 파일 스캐너가 상태 판정에 제공하는 최소 불변 projection. */
export interface ScannedLabRunStateRecord {
  grantId: string;
  promptVersion: string;
  startedAt: string;
  /** 같은 startedAt의 결정적 tie-breaker. 보통 상대 파일 경로다. */
  identity: string;
  primaryValidationOutcome?: unknown;
  error?: unknown;
}

export interface ResolvedGrantRunState<T extends ScannedLabRunStateRecord> {
  state: GrantRunState;
  /** 현행 prompt의 최신 publishable/held 런. 실패 시도는 품질 종결을 덮지 않는다. */
  latestCurrentTerminal: T | null;
}

/**
 * grant별 파일 여러 개를 배치 재착수 상태로 접는다.
 *
 * 현행 prompt에서는 최신 품질 종결(publishable/held) 하나만 권위를 가진다. 품질 종결이
 * 하나도 없을 때에만 failed 시도를 errorCurrent로 보존한다. 이 규칙은 과거 publishable과
 * 최신 held를 OR해서 성공으로 만드는 fail-open을 막으면서, 이후의 인프라 실패가 이미 남은
 * 불변 품질 종결을 지우는 것도 방지한다.
 */
export function resolveGrantRunStates<T extends ScannedLabRunStateRecord>(
  records: readonly T[],
  currentPromptVersion: string,
): Map<string, ResolvedGrantRunState<T>> {
  const working = new Map<string, {
    latestCurrentTerminal: T | null;
    hasCurrentFailure: boolean;
    hasOutdatedPublishable: boolean;
  }>();

  for (const record of records) {
    const current = working.get(record.grantId) ?? {
      latestCurrentTerminal: null,
      hasCurrentFailure: false,
      hasOutdatedPublishable: false,
    };
    const outcome = classifyLabRunOutcome(record);
    if (record.promptVersion === currentPromptVersion) {
      if (outcome === "failed") {
        current.hasCurrentFailure = true;
      } else if (
        current.latestCurrentTerminal === null
        || compareRunOrder(record, current.latestCurrentTerminal) > 0
      ) {
        current.latestCurrentTerminal = record;
      }
    } else if (outcome === "publishable") {
      current.hasOutdatedPublishable = true;
    }
    working.set(record.grantId, current);
  }

  const resolved = new Map<string, ResolvedGrantRunState<T>>();
  for (const [grantId, item] of working) {
    const terminalOutcome = item.latestCurrentTerminal
      ? classifyLabRunOutcome(item.latestCurrentTerminal)
      : null;
    resolved.set(grantId, {
      state: {
        okCurrent: terminalOutcome === "publishable",
        okOutdated: item.hasOutdatedPublishable,
        heldCurrent: terminalOutcome === "held",
        errorCurrent: terminalOutcome === null && item.hasCurrentFailure,
      },
      latestCurrentTerminal: item.latestCurrentTerminal,
    });
  }
  return resolved;
}

function compareRunOrder(left: ScannedLabRunStateRecord, right: ScannedLabRunStateRecord): number {
  const startedAtOrder = left.startedAt.localeCompare(right.startedAt);
  return startedAtOrder !== 0 ? startedAtOrder : left.identity.localeCompare(right.identity);
}

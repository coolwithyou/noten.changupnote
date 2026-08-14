export interface ApplicationRoundtripOptIn {
  withApplicationRoundtrip?: boolean;
  roundtripModel?: string;
  reuseApplicationRoundtripRunId?: string;
}

/** Kordoc 실행을 요구하는 세부 옵션은 명시적 true opt-in 없이 독립적으로 쓸 수 없다. */
export function assertApplicationRoundtripOptIn(options: ApplicationRoundtripOptIn): void {
  if (options.roundtripModel !== undefined && options.withApplicationRoundtrip !== true) {
    throw new Error("roundtripModel은 withApplicationRoundtrip=true와 함께 지정해야 합니다.");
  }
  if (
    options.reuseApplicationRoundtripRunId !== undefined
    && options.withApplicationRoundtrip !== true
  ) {
    throw new Error(
      "reuseApplicationRoundtripRunId는 withApplicationRoundtrip=true와 함께 지정해야 합니다.",
    );
  }
}

/**
 * deep repair는 기존 Kordoc 산출물을 검증·재결속할 수 있을 때만 opt-in한다.
 * application repair는 신청 계약 자체가 재검증 대상이므로 현행처럼 end-to-end로 다시 실행한다.
 */
export function resolveRepairApplicationRoundtripOptions(input: {
  contract: "deep" | "application";
  existingRunId: string | null | undefined;
  model: string;
}): ApplicationRoundtripOptIn {
  if (input.contract === "application") {
    return {
      withApplicationRoundtrip: true,
      roundtripModel: input.model,
    };
  }
  if (input.existingRunId) {
    return {
      withApplicationRoundtrip: true,
      reuseApplicationRoundtripRunId: input.existingRunId,
      roundtripModel: input.model,
    };
  }
  return {};
}

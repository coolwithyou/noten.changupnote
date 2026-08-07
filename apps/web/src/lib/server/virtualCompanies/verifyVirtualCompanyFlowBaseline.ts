import type {
  VirtualCompanyAuthoringBaseline,
  VirtualCompanyTarget,
} from "./catalog";

export type VirtualCompanyFlowBaselineStatus =
  | "pass"
  | "product_regression"
  | "needs_rebaseline";

export interface VirtualCompanyFlowObservation {
  documentKey: string | null;
  sourceSha256: string | null;
  authoring: VirtualCompanyAuthoringBaseline | null;
}

export interface VirtualCompanyFlowBaselineResult {
  status: VirtualCompanyFlowBaselineStatus;
  issues: string[];
  expected: {
    documentKey: string;
    sourceSha256: string;
    authoring: VirtualCompanyAuthoringBaseline | null;
  };
  actual: VirtualCompanyFlowObservation;
}

/**
 * 가상 기업 작성 경로의 재현 기준선을 비교한다.
 *
 * 공고 원본의 정체성(documentKey/SHA)이 달라지면 새 원본을 사람에게 재검토하도록
 * needs_rebaseline로 멈춘다. 같은 원본에서 문서/필드/시드 수만 달라진 경우에는
 * 제품 코드 회귀로 분리해 원본 변경과 구현 오류를 섞지 않는다.
 */
export function verifyVirtualCompanyFlowBaseline(input: {
  target: VirtualCompanyTarget;
  actual: VirtualCompanyFlowObservation;
}): VirtualCompanyFlowBaselineResult {
  if (!input.target.expectedDocument) {
    throw new Error("작성 기준선 검증에는 expectedDocument가 필요합니다.");
  }
  const rebaselineIssues: string[] = [];
  const regressionIssues: string[] = [];
  const expectedAuthoring = input.target.expectedAuthoring ?? null;

  if (input.actual.documentKey !== input.target.expectedDocument.documentKey) {
    rebaselineIssues.push(
      `기준 문서 변경: expected=${input.target.expectedDocument.documentKey}, actual=${input.actual.documentKey ?? "missing"}`,
    );
  }
  if (input.actual.sourceSha256 !== input.target.expectedDocument.sourceSha256) {
    rebaselineIssues.push(
      `원본 SHA-256 변경: expected=${input.target.expectedDocument.sourceSha256}, actual=${input.actual.sourceSha256 ?? "missing"}`,
    );
  }

  if (expectedAuthoring) {
    if (!input.actual.authoring) {
      regressionIssues.push("작성 화면 기대값을 관측하지 못했습니다.");
    } else {
      compareCount("문서 수", expectedAuthoring.documentCount, input.actual.authoring.documentCount, regressionIssues);
      compareCount(
        "연결 필드 수",
        expectedAuthoring.connectedFieldCount,
        input.actual.authoring.connectedFieldCount,
        regressionIssues,
      );
      compareCount(
        "자동 시드 수",
        expectedAuthoring.seededAnswerCount,
        input.actual.authoring.seededAnswerCount,
        regressionIssues,
      );
      compareCount(
        "수동 질문 수",
        expectedAuthoring.manualQuestionCount,
        input.actual.authoring.manualQuestionCount,
        regressionIssues,
      );
      compareCount("페이지 수", expectedAuthoring.pageCount, input.actual.authoring.pageCount, regressionIssues);
    }
  } else if (input.actual.authoring) {
    regressionIssues.push("작성 진입 전 시나리오에서 작성 화면이 열렸습니다.");
  }

  const issues = [...rebaselineIssues, ...regressionIssues];
  return {
    status: rebaselineIssues.length > 0
      ? "needs_rebaseline"
      : regressionIssues.length > 0
        ? "product_regression"
        : "pass",
    issues,
    expected: {
      documentKey: input.target.expectedDocument.documentKey,
      sourceSha256: input.target.expectedDocument.sourceSha256,
      authoring: expectedAuthoring,
    },
    actual: input.actual,
  };
}

function compareCount(
  label: string,
  expected: number,
  actual: number,
  issues: string[],
): void {
  if (actual !== expected) issues.push(`${label} 불일치: expected=${expected}, actual=${actual}`);
}

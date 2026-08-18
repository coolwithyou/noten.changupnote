import { CRITERION_DIMENSIONS, hasExactDeepAnalysisAxisCoverage } from "@cunote/contracts";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabRun,
} from "@/lib/server/analysis-lab/lab-contract";
import {
  ANALYSIS_QUALITY_POLICY_VERSION,
  type AnalysisQualityDownstreamEvidence,
  type AnalysisQualityEdge,
  type AnalysisQualityGraph,
  type AnalysisQualityLane,
  type AnalysisQualityMetrics,
  type AnalysisQualityNode,
  type AnalysisQualityNodeId,
  type AnalysisQualityReviewEvidence,
  type AnalysisQualityStatus,
} from "@/lib/server/analysis-lab/quality-contract";
import { assessPromotionReviewRisk } from "./promotion-review-risk";
import { classifyLabRunOutcome } from "./run-outcome";

export interface AnalysisQualityGraphInput {
  run: LabRun;
  review: AnalysisQualityReviewEvidence | null;
  roundtrip: ApplicationRoundtripRun | null;
  deepPromotion?: AnalysisQualityDownstreamEvidence | null;
  fieldMaterialization?: AnalysisQualityDownstreamEvidence | null;
  matchingCanary?: AnalysisQualityDownstreamEvidence | null;
  workspaceCanary?: AnalysisQualityDownstreamEvidence | null;
}

const SHA256 = /^[a-f0-9]{64}$/;
const APPLICATION_ROLES = new Set(["application_form", "business_plan", "mixed_form"]);

/**
 * 딥분석과 Kordoc의 품질 판정을 한 인터페이스 뒤에 숨긴다.
 *
 * 이 함수는 "모든 것이 완벽해야 성공"으로 축약하지 않는다. 정확히 확정된 결과는 passed,
 * 안전하게 사용할 수 있으나 일부 신호를 보류한 결과는 partial, 신청 가능 여부나 필수 입력을
 * 확정하지 못하면 held, 계약 자체가 깨졌으면 failed로 구분한다. 승격·제품 카나리 증거가
 * 주입되지 않은 경우에는 성공으로 추정하지 않고 not_evaluated로 남긴다.
 */
export function evaluateAnalysisQuality(input: AnalysisQualityGraphInput): AnalysisQualityGraph {
  const deepNodes = evaluateDeepAnalysis(input);
  const applicationNodes = evaluateApplication(input);
  const productNodes = [
    downstreamNode("deep_promotion", "딥분석 승격", input.deepPromotion),
    downstreamNode("matching_canary", "매칭 시뮬레이션", input.matchingCanary),
    downstreamNode("field_materialization", "빠른 작성 반영", input.fieldMaterialization),
    downstreamNode("workspace_canary", "지원서 작성 시뮬레이션", input.workspaceCanary),
  ];
  const nodes = [...deepNodes, ...applicationNodes, ...productNodes];
  const lanes = {
    deep_analysis: reduceStatuses(deepNodes.map((node) => node.status)),
    application: reduceStatuses(applicationNodes.map((node) => node.status)),
    product: reduceStatuses(productNodes.map((node) => node.status)),
  } satisfies Record<AnalysisQualityLane, AnalysisQualityStatus>;

  return {
    policyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
    grantId: input.run.grantId,
    runId: input.run.runId,
    title: input.run.title,
    evaluatedAt: new Date().toISOString(),
    analysisReadiness: reduceStatuses([lanes.deep_analysis, lanes.application]),
    productReadiness: lanes.product,
    lanes,
    nodes,
    edges: QUALITY_GRAPH_EDGES,
    metrics: buildMetrics(input.run, input.roundtrip),
  };
}

function evaluateDeepAnalysis(input: AnalysisQualityGraphInput): AnalysisQualityNode[] {
  const { run } = input;
  const runOutcome = classifyLabRunOutcome(run);
  const validationHeld = runOutcome === "held";
  const runFailed = runOutcome === "failed";
  const inputIssues = [
    ...(!SHA256.test(run.inputSha256) ? ["입력 SHA-256이 없거나 형식이 올바르지 않습니다."] : []),
    ...(run.inputBlocks.length === 0 || run.inputTotalChars <= 0 ? ["봉인된 입력 블록이 없습니다."] : []),
    ...run.inputBlocks.filter((block) => block.truncated).map((block) => `입력 잘림: ${block.label}`),
  ];
  const inputContractBroken = !SHA256.test(run.inputSha256) || run.inputBlocks.length === 0 || run.inputTotalChars <= 0;
  const inputStatus: AnalysisQualityStatus = inputContractBroken
    ? "failed"
    : run.inputBlocks.some((block) => block.truncated)
      ? "partial"
      : "passed";

  const groundedCriteria = run.criteria.filter((criterion) =>
    criterion.spanVerified && Boolean(criterion.sourceSpan?.trim())).length;
  const contractIssues = [
    ...(runFailed ? [`분석 오류: ${run.error ?? "outcome/error contract mismatch"}`] : []),
    ...(run.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
      ? [`구 분석 정책: ${run.promptVersion} (현재 ${ANALYSIS_LAB_PROMPT_VERSION})`]
      : []),
    ...(!hasExactDeepAnalysisAxisCoverage(run.axisAssessments)
      ? [`22축 평가가 완전하지 않습니다: ${run.axisAssessments.length}/${CRITERION_DIMENSIONS.length}`]
      : []),
    ...(groundedCriteria !== run.criteria.length
      ? [`원문 근거가 검증되지 않은 조건 ${run.criteria.length - groundedCriteria}건`]
      : []),
    ...(run.analysisMarkdown.trim().length === 0 ? ["사람이 읽을 분석 문서가 비어 있습니다."] : []),
  ];
  const inputMissingAxes = run.axisAssessments.filter((axis) => axis.status === "input_missing").length;
  const ambiguousAxes = run.axisAssessments.filter((axis) => axis.status === "ambiguous").length;
  let contractStatus: AnalysisQualityStatus = "passed";
  if (
    runFailed
    || (validationHeld && inputMissingAxes === 0 && ambiguousAxes === 0)
    || !hasExactDeepAnalysisAxisCoverage(run.axisAssessments)
    || groundedCriteria !== run.criteria.length
  ) {
    contractStatus = "failed";
  } else if (run.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION || inputMissingAxes > 0) {
    contractStatus = "held";
  } else if (ambiguousAxes > 0) {
    contractStatus = "partial";
  }

  return [
    {
      id: "input_sealed",
      lane: "deep_analysis",
      label: "입력 봉인",
      status: inputStatus,
      hardGate: true,
      summary: inputStatus === "passed"
        ? `입력 ${run.inputBlocks.length}개 블록의 해시가 봉인됐습니다.`
        : inputStatus === "partial"
          ? `변환되지 않은 첨부 ${run.inputBlocks.filter((block) => block.truncated).length}건을 명시적으로 보류했습니다.`
          : inputIssues[0]!,
      evidence: inputStatus === "passed" ? [`sha256 ${run.inputSha256}`, `총 ${run.inputTotalChars.toLocaleString()}자`] : inputIssues,
      nextAction: inputStatus === "failed" ? "첨부 변환과 입력 조립을 다시 실행하세요." : null,
    },
    {
      id: "deep_contract",
      lane: "deep_analysis",
      label: "22축·원문 근거 계약",
      status: contractStatus,
      hardGate: true,
      summary: contractStatus === "passed"
        ? `22축과 조건 ${run.criteria.length}건이 원문 근거로 검증됐습니다.`
        : contractIssues[0]
          ?? (inputMissingAxes > 0
            ? `원문 입력이 부족한 축 ${inputMissingAxes}건이 남았습니다.`
            : `애매한 축 ${ambiguousAxes}건을 안전하게 보류했습니다.`),
      evidence: [
        `축 ${run.axisAssessments.length}/${CRITERION_DIMENSIONS.length}`,
        `근거 검증 ${groundedCriteria}/${run.criteria.length}`,
        `애매 ${ambiguousAxes} · 입력 부족 ${inputMissingAxes}`,
        ...(run.primaryRepairCount !== undefined
          ? [`validator 자동 교정 ${run.primaryRepairCount}회`]
          : []),
        ...contractIssues,
      ],
      nextAction: contractStatus === "passed" ? null : "현행 정책으로 재분석하거나 부족한 원문을 보강하세요.",
    },
    evaluateReview(input),
  ];
}

function evaluateReview(input: AnalysisQualityGraphInput): AnalysisQualityNode {
  const evidence = input.review;
  if (!evidence) {
    return {
      id: "independent_review",
      lane: "deep_analysis",
      label: "독립 AI 검수",
      status: "held",
      hardGate: true,
      summary: "독립 검수 또는 완료된 감사 증거가 없습니다.",
      evidence: [],
      nextAction: "추출 모델과 다른 모델로 AI 검수와 블라인드 감사를 실행하세요.",
    };
  }
  if (!evidence.complete || !evidence.currentPolicy) {
    return {
      id: "independent_review",
      lane: "deep_analysis",
      label: "독립 AI 검수",
      status: "held",
      hardGate: true,
      summary: evidence.complete ? "검수 정책이 현행 버전이 아닙니다." : "독립 검수가 아직 종결되지 않았습니다.",
      evidence: [`검수 경로 ${evidence.source}`, `완료 ${evidence.complete ? "예" : "아니오"}`],
      nextAction: "현행 검수 정책으로 미판정 항목을 종결하세요.",
    };
  }
  const risk = assessPromotionReviewRisk({ run: input.run, review: evidence.review });
  const status: AnalysisQualityStatus = risk.disposition === "verified"
    ? "passed"
    : risk.disposition === "conditional"
      ? "partial"
      : "held";
  return {
    id: "independent_review",
    lane: "deep_analysis",
    label: "독립 AI 검수",
    status,
    hardGate: true,
    summary: risk.disposition === "verified"
      ? "독립 판정이 신청자격 조건을 확인했습니다."
      : risk.disposition === "conditional"
        ? `랭킹 신호 ${risk.deferrals.length}건을 제외하고 안전하게 사용할 수 있습니다.`
        : `신청 가능 여부를 바꿀 수 있는 검수 쟁점 ${risk.blockers.length}건이 남았습니다.`,
    evidence: [
      `검수 경로 ${evidence.source}`,
      `차단 ${risk.blockers.length} · 보류 ${risk.deferrals.length}`,
      ...risk.blockers.slice(0, 3).map((item) => item.detail),
    ],
    nextAction: status === "held" ? "고성능 독립 모델로 차단 항목만 다시 판정하세요." : null,
  };
}

function evaluateApplication(input: AnalysisQualityGraphInput): AnalysisQualityNode[] {
  const reference = input.run.applicationRoundtrip;
  if (!reference) return [missingApplicationNode("application_source"), missingApplicationNode("field_adjudication")];
  if (reference.status === "not_applicable") {
    return [notApplicableApplicationNode("application_source"), notApplicableApplicationNode("field_adjudication")];
  }
  if (reference.status === "failed") {
    const summary = reference.error ?? reference.errorCode ?? "Kordoc 실행이 실패했습니다.";
    return [
      applicationFailureNode("application_source", summary),
      applicationFailureNode("field_adjudication", "문서 분석 실패로 필드 판정을 시작할 수 없습니다."),
    ];
  }
  const roundtrip = input.roundtrip;
  if (!roundtrip) {
    return [
      applicationHoldNode("application_source", "LabRun이 가리키는 Kordoc 산출물을 찾지 못했습니다."),
      applicationHoldNode("field_adjudication", "후보 판정 산출물을 검증할 수 없습니다."),
    ];
  }

  const provenanceIssues = [
    ...(roundtrip.version !== APPLICATION_ROUNDTRIP_VERSION
      ? [`구 Kordoc 정책: ${roundtrip.version}`]
      : []),
    ...(roundtrip.parentLabRunId !== input.run.runId ? ["딥분석 런과 Kordoc 런의 결속이 다릅니다."] : []),
    ...(roundtrip.transport !== "claude-cli" ? ["구독 모델 전송 증거가 아닙니다."] : []),
    ...(roundtrip.requestedModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
      ? [`채택 모델이 아닙니다: ${roundtrip.requestedModel ?? "미기록"}`]
      : []),
    ...((roundtrip.sourceCount ?? roundtrip.documents.length)
      !== roundtrip.documents.length + (roundtrip.skippedDocumentCount ?? 0)
      ? ["발견한 원본 수와 처리·스킵 문서 수가 맞지 않습니다."]
      : []),
    ...((roundtrip.skippedDocumentCount ?? 0) > 0 ? [`미처리 문서 ${roundtrip.skippedDocumentCount}건`] : []),
    ...roundtrip.documents.filter((document) => document.error).map((document) => `${document.filename}: ${document.error}`),
  ];
  const sourceStatus: AnalysisQualityStatus = roundtrip.error || roundtrip.documents.some((document) => document.error)
    ? "failed"
    : provenanceIssues.length > 0
      ? "held"
      : "passed";

  const applicationDocuments = roundtrip.documents.filter((document) => APPLICATION_ROLES.has(document.role));
  const unresolved = unresolvedApplicationFields(applicationDocuments);
  const planningIssues = applicationDocuments.flatMap((document) => [
    ...((document.fieldPlanning.failureCode ?? null) ? [`${document.filename}: ${document.fieldPlanning.failureCode}`] : []),
    ...((document.fieldPlanning.unprocessedCandidateCount ?? 0) > 0
      ? [`${document.filename}: 미판정 후보 ${document.fieldPlanning.unprocessedCandidateCount}건`]
      : []),
  ]);
  const fieldStatus: AnalysisQualityStatus = applicationDocuments.length === 0
    ? "not_applicable"
    : planningIssues.length > 0 || unresolved.required > 0
      ? "held"
      : unresolved.total > 0 || unresolved.structural > 0
        ? "partial"
        : "passed";

  return [
    {
      id: "application_source",
      lane: "application",
      label: "Kordoc 원본·파싱",
      status: sourceStatus,
      hardGate: true,
      summary: sourceStatus === "passed"
        ? `HWP/HWPX ${roundtrip.documents.length}건을 현행 Kordoc 정책으로 처리했습니다.`
        : provenanceIssues[0] ?? roundtrip.error ?? "Kordoc 파싱이 실패했습니다.",
      evidence: [
        `${roundtrip.version} · ${roundtrip.transport ?? "미기록"} · ${roundtrip.requestedModel ?? "미기록"}`,
        `원본 ${roundtrip.sourceCount ?? roundtrip.documents.length} · 처리 ${roundtrip.documents.length}`,
        ...(roundtrip.reusedFromRunId ? [`검증된 불변 산출물 재결속: ${roundtrip.reusedFromRunId}`] : []),
        ...provenanceIssues,
      ],
      nextAction: sourceStatus === "passed" ? null : "현행 Kordoc 정책으로 이 공고만 다시 분석하세요.",
    },
    {
      id: "field_adjudication",
      lane: "application",
      label: "빠른 작성 필드 판정",
      status: fieldStatus,
      hardGate: true,
      summary: fieldStatus === "passed"
        ? "지원 양식의 모든 입력 후보가 판정됐습니다."
        : fieldStatus === "partial"
          ? `안전한 필드는 사용할 수 있고 비필수 미해결 ${unresolved.total}건은 보류했습니다.`
          : fieldStatus === "not_applicable"
            ? "빠른 작성 대상 지원 양식이 없습니다."
            : `필수 미해결 ${unresolved.required}건 또는 미판정 후보가 남았습니다.`,
      evidence: [
        `지원 양식 ${applicationDocuments.length}건`,
        `미해결 ${unresolved.total} · 필수 미해결 ${unresolved.required} · 구조 경고 ${unresolved.structural}`,
        ...planningIssues,
      ],
      nextAction: fieldStatus === "held" ? "미해결 후보만 고성능 모델로 재판정하세요." : null,
    },
  ];
}

function unresolvedApplicationFields(documents: RoundtripParsedDocument[]): {
  total: number;
  required: number;
  structural: number;
} {
  let total = 0;
  let required = 0;
  let structural = 0;
  for (const document of documents) {
    total += document.fieldCoverage.unresolvedCandidateCount;
    structural += document.fieldCoverage.structuralWarningCount;
    const requiredIds = new Set(document.fields.filter((field) => field.required).map((field) => field.fieldInstanceId));
    required += document.fieldCoverage.unresolvedCandidates.filter((issue) => requiredIds.has(issue.fieldInstanceId)).length;
  }
  return { total, required, structural };
}

function buildMetrics(run: LabRun, roundtrip: ApplicationRoundtripRun | null): AnalysisQualityMetrics {
  const applicationDocuments = (roundtrip?.documents ?? []).filter((document) => APPLICATION_ROLES.has(document.role));
  const unresolved = unresolvedApplicationFields(applicationDocuments);
  return {
    criteria: run.criteria.length,
    groundedCriteria: run.criteria.filter((criterion) => criterion.spanVerified && Boolean(criterion.sourceSpan?.trim())).length,
    assessedAxes: run.axisAssessments.length,
    ambiguousAxes: run.axisAssessments.filter((axis) => axis.status === "ambiguous").length,
    inputMissingAxes: run.axisAssessments.filter((axis) => axis.status === "input_missing").length,
    applicationDocuments: applicationDocuments.length,
    fieldCandidates: applicationDocuments.reduce((sum, document) => sum + document.fields.length, 0),
    acceptedFields: applicationDocuments.reduce((sum, document) => sum + document.recommendedInputFieldCount, 0),
    unresolvedFields: unresolved.total,
    requiredUnresolvedFields: unresolved.required,
  };
}

function downstreamNode(
  id: Extract<AnalysisQualityNodeId, "deep_promotion" | "matching_canary" | "field_materialization" | "workspace_canary">,
  label: string,
  evidence: AnalysisQualityDownstreamEvidence | null | undefined,
): AnalysisQualityNode {
  return {
    id,
    lane: "product",
    label,
    status: evidence ? evidence.status : "not_evaluated",
    hardGate: true,
    summary: evidence?.summary ?? "이 런에 결속된 제품 증거가 아직 없습니다.",
    evidence: evidence?.evidence ?? [],
    nextAction: evidence ? null : `${label} 카나리를 실행해 런 ID와 입력 해시를 결속하세요.`,
  };
}

function missingApplicationNode(id: "application_source" | "field_adjudication"): AnalysisQualityNode {
  return {
    id,
    lane: "application",
    label: id === "application_source" ? "Kordoc 원본·파싱" : "빠른 작성 필드 판정",
    status: "not_evaluated",
    hardGate: true,
    summary: "이 딥분석 런에는 Kordoc 선분석 기록이 없습니다.",
    evidence: [],
    nextAction: "딥분석과 Kordoc 선분석을 같은 공고에서 병렬 실행하세요.",
  };
}

function notApplicableApplicationNode(id: "application_source" | "field_adjudication"): AnalysisQualityNode {
  return {
    id,
    lane: "application",
    label: id === "application_source" ? "Kordoc 원본·파싱" : "빠른 작성 필드 판정",
    status: "not_applicable",
    hardGate: false,
    summary: "빠른 작성 대상 HWP/HWPX 지원 양식이 없습니다.",
    evidence: [],
    nextAction: null,
  };
}

function applicationFailureNode(id: "application_source" | "field_adjudication", summary: string): AnalysisQualityNode {
  return {
    id,
    lane: "application",
    label: id === "application_source" ? "Kordoc 원본·파싱" : "빠른 작성 필드 판정",
    status: "failed",
    hardGate: true,
    summary,
    evidence: [],
    nextAction: "실패 코드를 보존한 채 이 공고만 재실행하세요.",
  };
}

function applicationHoldNode(id: "application_source" | "field_adjudication", summary: string): AnalysisQualityNode {
  return {
    id,
    lane: "application",
    label: id === "application_source" ? "Kordoc 원본·파싱" : "빠른 작성 필드 판정",
    status: "held",
    hardGate: true,
    summary,
    evidence: [],
    nextAction: "결속된 Kordoc 산출물을 복구하거나 다시 분석하세요.",
  };
}

function reduceStatuses(statuses: AnalysisQualityStatus[]): AnalysisQualityStatus {
  const effective = statuses.filter((status) => status !== "not_applicable");
  if (effective.length === 0) return "not_applicable";
  if (effective.includes("failed")) return "failed";
  if (effective.includes("held")) return "held";
  if (effective.includes("partial")) return "partial";
  if (effective.includes("not_evaluated")) return "not_evaluated";
  return "passed";
}

const QUALITY_GRAPH_EDGES: AnalysisQualityEdge[] = [
  { from: "input_sealed", to: "deep_contract", kind: "sequence" },
  { from: "deep_contract", to: "independent_review", kind: "sequence" },
  { from: "independent_review", to: "deep_promotion", kind: "sequence" },
  { from: "deep_promotion", to: "matching_canary", kind: "sequence" },
  { from: "matching_canary", to: "deep_contract", kind: "feedback" },
  { from: "application_source", to: "field_adjudication", kind: "sequence" },
  { from: "field_adjudication", to: "field_materialization", kind: "sequence" },
  { from: "field_materialization", to: "workspace_canary", kind: "sequence" },
  { from: "workspace_canary", to: "field_adjudication", kind: "feedback" },
];

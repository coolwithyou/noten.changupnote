import type {
  GrantAuthoringGuideV1,
  GrantCriterion,
} from "@cunote/contracts";
import type { LabRun } from "./lab-contract";

const SHA256_RE = /^[0-9a-f]{64}$/u;

export function buildGrantAuthoringGuide(input: {
  run: Pick<
    LabRun,
    | "runId"
    | "inputSha256"
    | "sourceRevisionSha256"
    | "attachmentManifestSha256"
    | "programIntent"
  >;
  criteria: readonly GrantCriterion[];
}): GrantAuthoringGuideV1 | null {
  if (!input.run.programIntent) return null;
  return {
    schemaVersion: "grant-authoring-guide-v1",
    source: {
      runId: input.run.runId,
      inputSha256: input.run.inputSha256,
      sourceRevisionSha256: validSha256(input.run.sourceRevisionSha256),
      attachmentManifestSha256: validSha256(input.run.attachmentManifestSha256),
    },
    intent: {
      oneLiner: normalizeText(input.run.programIntent.oneLiner),
      targetProfile: normalizeText(input.run.programIntent.targetProfile),
      evaluationFocus: normalizeTextList(input.run.programIntent.evaluationFocus),
      benefitSummary: normalizeText(input.run.programIntent.benefitSummary),
      cautionNotes: normalizeTextList(input.run.programIntent.cautionNotes),
    },
    evidenceChecklist: input.criteria.flatMap((criterion) => {
      const sourceSpan = normalizeText(criterion.source_span ?? "");
      if (!sourceSpan) return [];
      return [{
        dimension: criterion.dimension,
        kind: criterion.kind,
        operator: criterion.operator,
        value: criterion.value,
        sourceSpan,
      }];
    }),
  };
}

export function isGrantAuthoringGuideV1(value: unknown): value is GrantAuthoringGuideV1 {
  if (!value || typeof value !== "object") return false;
  const guide = value as Partial<GrantAuthoringGuideV1>;
  return guide.schemaVersion === "grant-authoring-guide-v1"
    && Boolean(guide.source)
    && typeof guide.source?.runId === "string"
    && SHA256_RE.test(guide.source.inputSha256 ?? "")
    && validNullableSha(guide.source.sourceRevisionSha256)
    && validNullableSha(guide.source.attachmentManifestSha256)
    && Boolean(guide.intent)
    && typeof guide.intent?.oneLiner === "string"
    && typeof guide.intent?.targetProfile === "string"
    && Array.isArray(guide.intent?.evaluationFocus)
    && typeof guide.intent?.benefitSummary === "string"
    && Array.isArray(guide.intent?.cautionNotes)
    && Array.isArray(guide.evidenceChecklist);
}

export function formatGrantAuthoringGuide(guide: GrantAuthoringGuideV1): string {
  const lines = [
    "[검증된 공고 작성 가이드]",
    `사업 목적: ${guide.intent.oneLiner}`,
    `목표 지원자상: ${guide.intent.targetProfile}`,
    `지원 혜택: ${guide.intent.benefitSummary}`,
    ...guide.intent.evaluationFocus.map((item) => `평가 포인트: ${item}`),
    ...guide.intent.cautionNotes.map((item) => `주의사항: ${item}`),
    ...guide.evidenceChecklist.map((item) => (
      `확인 조건(${item.dimension}/${item.kind}): ${item.operator} ${stableJson(item.value)}\n근거: ${item.sourceSpan}`
    )),
    "이 가이드는 작성 방향을 위한 advisory입니다. 회사 사실·수치·실적은 확인된 사용자 정보만 사용하세요.",
  ];
  return lines.filter((line) => line.trim().length > 0).join("\n");
}

export function authoringGuideMatchesSource(input: {
  guide: GrantAuthoringGuideV1;
  runId: string;
  inputSha256: string | null;
  sourceRevisionSha256: string;
  attachmentManifestSha256: string | null;
}): boolean {
  return input.inputSha256 !== null
    && input.guide.source.runId === input.runId
    && input.guide.source.inputSha256 === input.inputSha256
    && input.guide.source.sourceRevisionSha256 === input.sourceRevisionSha256
    && (input.attachmentManifestSha256 === null
      || input.guide.source.attachmentManifestSha256 === input.attachmentManifestSha256);
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function normalizeTextList(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function validSha256(value: string | undefined): string | null {
  return value && SHA256_RE.test(value) ? value : null;
}

function validNullableSha(value: string | null | undefined): boolean {
  return value === null || (typeof value === "string" && SHA256_RE.test(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

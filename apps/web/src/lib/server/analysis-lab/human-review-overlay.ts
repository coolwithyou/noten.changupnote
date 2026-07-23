// 공모 딥분석 실험실 — 감사 동결 목록 밖 확장 검수 결과 사이드카.
// 감사 파일(lab-audit-v1)의 대상 목록은 불변이므로 span 미검증·저신뢰 correct·질문
// 스팟체크 판정은 <runId>.human-overlay.json 에만 기록한다.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CriterionDimension,
} from "@cunote/contracts";
import type {
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
} from "@/features/dev/analysis-lab/contract";
import { analysisLabDir, modelSlug } from "./run-store";

export const HUMAN_REVIEW_OVERLAY_SCHEMA = "human-review-overlay-v1" as const;

export interface HumanReviewOverlayItem {
  sourceItemKey: string;
  itemKind: "criterion" | "axis" | "question_check";
  criterionIndex?: number;
  dimension?: CriterionDimension;
  humanVerdict: LabCriterionVerdict | LabEmptyAxisVerdict;
  note: string | null;
  decidedBy: string;
  decidedAt: string;
  revision: number;
}

export interface HumanReviewOverlay {
  schema: typeof HUMAN_REVIEW_OVERLAY_SCHEMA;
  grantId: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  items: HumanReviewOverlayItem[];
}

export function humanReviewOverlayFilePath(
  source: string,
  sourceId: string,
  runId: string,
): string {
  const dir = `${modelSlug(source)}__${modelSlug(sourceId)}`;
  return join(analysisLabDir(), dir, `${runId}.human-overlay.json`);
}

export async function readHumanReviewOverlayFile(
  path: string,
): Promise<HumanReviewOverlay | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<HumanReviewOverlay>;
    if (
      parsed.schema !== HUMAN_REVIEW_OVERLAY_SCHEMA
      || typeof parsed.grantId !== "string"
      || typeof parsed.runId !== "string"
      || !Array.isArray(parsed.items)
    ) return null;
    return parsed as HumanReviewOverlay;
  } catch {
    return null;
  }
}

/** 같은 sourceItemKey는 revision이 높은 최신 판정으로 교체하고 나머지 이력은 DB에 보존한다. */
export function mergeHumanReviewOverlay(
  current: HumanReviewOverlay | null,
  input: {
    grantId: string;
    runId: string;
    items: HumanReviewOverlayItem[];
    now: string;
  },
): HumanReviewOverlay {
  if (current && (current.grantId !== input.grantId || current.runId !== input.runId)) {
    throw new Error("human overlay의 grantId/runId가 수거 대상과 일치하지 않습니다.");
  }
  const byKey = new Map((current?.items ?? []).map((item) => [item.sourceItemKey, item]));
  for (const item of input.items) {
    const previous = byKey.get(item.sourceItemKey);
    if (!previous || item.revision >= previous.revision) byKey.set(item.sourceItemKey, item);
  }
  return {
    schema: HUMAN_REVIEW_OVERLAY_SCHEMA,
    grantId: input.grantId,
    runId: input.runId,
    createdAt: current?.createdAt ?? input.now,
    updatedAt: input.now,
    items: [...byKey.values()].sort((a, b) => a.sourceItemKey.localeCompare(b.sourceItemKey)),
  };
}

/** 임시 파일을 완성한 뒤 rename하여 부분 JSON 노출을 막는다. */
export async function writeHumanReviewOverlayAtomic(
  path: string,
  overlay: HumanReviewOverlay,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

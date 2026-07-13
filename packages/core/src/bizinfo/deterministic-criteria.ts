import type { GrantCriterion } from "@cunote/contracts";
import { REGION_CODES } from "../kstartup/constants.js";
import type { BizInfoProgramExtractionInput } from "./types.js";

const SIZE_LABELS = ["소상공인", "중소기업", "중견기업", "대기업", "소기업"] as const;

/** 기업마당 API structured field에서 고정 규칙으로 안전하게 복구할 수 있는 조건만 만든다. */
export function buildBizInfoDeterministicCriteria(input: BizInfoProgramExtractionInput): GrantCriterion[] {
  const criteria: GrantCriterion[] = [];
  const target = input.metadata.target ?? "";
  const targetBlock = input.blocks.find((block) => block.source_field === "trgetNm");
  const summaryBlock = input.blocks.find((block) => block.source_field === "bsnsSumryCn");
  const titleBlock = input.blocks.find((block) => block.source_field === "pblancNm");

  let remainingTarget = target;
  const sizes = SIZE_LABELS.filter((size) => {
    if (!remainingTarget.includes(size)) return false;
    remainingTarget = remainingTarget.replaceAll(size, " ");
    return true;
  });
  if (sizes.length > 0) {
    criteria.push({
      id: `bizinfo:${input.source_id}:det-size`,
      grant_id: input.source_id,
      dimension: "size",
      operator: "in",
      kind: "required",
      value: { sizes: [...sizes] },
      confidence: 0.98,
      source_span: targetBlock?.text ?? target,
      source_field: "trgetNm",
      parser_version: "bizinfo-structured-backstop-v1",
    });
  }

  const titleRegionSegment = input.title.match(/^\[([^\]]+)\]/)?.[1] ?? "";
  const regionLabels = Object.keys(REGION_CODES)
    .filter((label) => titleRegionSegment.includes(label))
    .sort((left, right) => titleRegionSegment.indexOf(left) - titleRegionSegment.indexOf(right));
  if (regionLabels.length > 0) {
    criteria.push({
      id: `bizinfo:${input.source_id}:det-region`,
      grant_id: input.source_id,
      dimension: "region",
      operator: "in",
      kind: "required",
      value: {
        regions: regionLabels.map((label) => REGION_CODES[label]!),
        labels: regionLabels,
        nationwide: false,
      },
      confidence: 0.98,
      source_span: `[${titleRegionSegment}]`,
      source_field: titleBlock?.source_field ?? "pblancNm",
      parser_version: "bizinfo-structured-backstop-v1",
    });
  }

  const summary = summaryBlock?.text ?? "";
  const targetTypes = [
    ...(containsBusinessType(summary, "법인사업자") ? ["법인사업자"] : []),
    ...(containsBusinessType(summary, "개인사업자") ? ["개인사업자"] : []),
  ];
  if (targetTypes.length > 0) {
    criteria.push({
      id: `bizinfo:${input.source_id}:det-target-type`,
      grant_id: input.source_id,
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: { targets: targetTypes },
      confidence: 0.9,
      source_span: containingSentence(summary, targetTypes[0]!),
      source_field: "bsnsSumryCn",
      parser_version: "bizinfo-structured-backstop-v1",
    });
  }

  return criteria;
}

export function mergeBizInfoDeterministicCriteria(
  deterministic: GrantCriterion[],
  extracted: GrantCriterion[],
): GrantCriterion[] {
  const merged = [...deterministic];
  for (const criterion of extracted) {
    const duplicate = merged.some((existing) =>
      existing.dimension === criterion.dimension &&
      existing.kind === criterion.kind &&
      existing.operator === criterion.operator &&
      canonicalJson(existing.value) === canonicalJson(criterion.value));
    if (!duplicate) merged.push(criterion);
  }
  return merged;
}

function containsBusinessType(text: string, value: "법인사업자" | "개인사업자"): boolean {
  return new RegExp(`${value.replace("사업자", "\\s*사업자")}(?:\\s|$|[),ㆍ·])`).test(text);
}

function containingSentence(text: string, needle: string): string {
  const sentence = text
    .split(/(?<=[.!?。]|\n)|(?=☞|※)/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .find((entry) => entry.includes(needle));
  return (sentence ?? needle).slice(0, 500);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue).sort();
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

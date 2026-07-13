import type { CriterionDimension, NextQuestionDto, PriorAwardQuestionContextDto, PriorAwardState } from "@cunote/contracts";
import {
  DISQUALIFICATION_QUESTIONS,
  type DisqualificationFlag,
  type DisqualificationQuestionId,
} from "@cunote/core";
import { regionCodeForLabel } from "@/lib/regions";

export const SELF_DECLARED_CONFIDENCE = 0.6;

export function selectedQuestionRange(question: NextQuestionDto, value: string) {
  if (question.responseStage !== "range") return null;
  return question.rangeOptions?.find((option) => option.value === value) ?? null;
}

export function defaultQuestionValue(question: NextQuestionDto): string {
  if (question.inputType === "select") return "";
  if (question.inputType === "boolean") return "true";
  return "";
}

export function parseQuestionValue(question: NextQuestionDto, value: string): unknown {
  if (question.inputType === "number") return Number(value);
  if (question.inputType === "boolean") return value === "true";
  if (question.dimension === "region") {
    return { code: regionCodeForLabel(value) ?? value, label: value };
  }
  if (question.dimension === "prior_award" && value === "해당 없음") return [];
  if (isListQuestionDimension(question.dimension)) return [value];
  return value;
}

export function isListQuestionDimension(dimension: NextQuestionDto["dimension"]): boolean {
  return (
    dimension === "industry" ||
    dimension === "founder_trait" ||
    dimension === "certification" ||
    dimension === "prior_award" ||
    dimension === "ip" ||
    dimension === "target_type"
  );
}

export function shouldMergeQuestionValue(question: NextQuestionDto, value: string): boolean {
  if (!isListQuestionDimension(question.dimension)) return false;
  return !(question.dimension === "prior_award" && value === "해당 없음");
}

export function buildDisqualificationAnswers(
  dimension: CriterionDimension,
  flags: DisqualificationFlag[],
  held: DisqualificationFlag[],
): Record<DisqualificationQuestionId, { held: DisqualificationFlag[] }> {
  const shown = new Set(flags);
  const heldSet = new Set(held);
  const answers = {} as Record<DisqualificationQuestionId, { held: DisqualificationFlag[] }>;
  for (const question of DISQUALIFICATION_QUESTIONS) {
    if (question.axis !== dimension) continue;
    const covered = question.covers.filter((flag) => shown.has(flag));
    if (covered.length === 0) continue;
    answers[question.id] = { held: covered.filter((flag) => heldSet.has(flag)) };
  }
  return answers;
}

export type NumberGroupItem =
  | {
      name: string;
      type: "number";
      label: string;
      placeholder?: string;
      hint?: string;
      allowNegative?: boolean;
      step?: string;
    }
  | { name: string; type: "boolean"; label: string; hint?: string };

export function numberGroupSpec(dimension: CriterionDimension): NumberGroupItem[] {
  if (dimension === "financial_health") {
    return [
      { name: "capital_impaired", type: "boolean", label: "자본잠식 상태인가요?", hint: "자본총계가 자본금보다 작으면 예" },
      { name: "debt_ratio_pct", type: "number", label: "부채비율(%) (선택)", placeholder: "예: 250" },
      {
        name: "interest_coverage_ratio",
        type: "number",
        label: "이자보상배율 (선택)",
        placeholder: "예: 1.5",
        hint: "영업이익÷이자비용. 영업손실이면 음수",
        allowNegative: true,
        step: "any",
      },
    ];
  }
  if (dimension === "insured_workforce") {
    return [
      { name: "employment_insurance_active", type: "boolean", label: "고용보험 가입 사업장인가요?" },
      { name: "insured_count", type: "number", label: "고용보험 피보험자 수 (선택)", placeholder: "예: 12" },
    ];
  }
  return [
    { name: "total_raised_krw", type: "number", label: "누적 투자 유치 금액(원) (선택)", placeholder: "예: 500000000" },
    { name: "tips_backed", type: "boolean", label: "TIPS 선정 이력이 있나요? (선택)" },
  ];
}

export function buildNumberGroupValue(
  dimension: CriterionDimension,
  fields: Record<string, string>,
): Record<string, unknown> | null {
  const value: Record<string, unknown> = {};
  let touched = false;
  for (const item of numberGroupSpec(dimension)) {
    const raw = fields[item.name];
    if (raw === undefined || raw === "") continue;
    if (item.type === "boolean") {
      value[item.name] = raw === "true";
      touched = true;
    } else {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && (item.allowNegative || parsed >= 0)) {
        value[item.name] = item.allowNegative ? parsed : Math.floor(parsed);
        touched = true;
      }
    }
  }
  return touched ? value : null;
}

export function buildPriorAwardQuestionValue(
  context: PriorAwardQuestionContextDto,
  answer: { hasHistory: boolean; state?: PriorAwardState; year?: number | null },
): Record<string, unknown> {
  if (context.scope === "self") {
    if (context.channel === "incubation_tenancy") {
      return { has_incubation_tenancy: answer.hasHistory };
    }
    return {
      self_flags: { [context.selfKind ?? "current_similar"]: answer.hasHistory },
    };
  }
  const programs = context.programs ?? [];
  const state = answer.state ?? context.states?.[0] ?? (context.scope === "program_type" ? "graduated" : "completed");
  return {
    records: answer.hasHistory
      ? programs.map((program) => ({
        program,
        state,
        ...(answer.year !== undefined ? { year: answer.year } : {}),
      }))
      : [],
    ...(context.scope === "program_type"
      ? { known_program_types: programs }
      : { known_programs: programs }),
  };
}

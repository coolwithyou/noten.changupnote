import type {
  CompanyProfile,
  MatchingProfileAnswerRequest,
} from "@cunote/contracts";
import {
  OPERATIONAL_PROFILE_DIMENSIONS,
  markProfileQuestionRange,
  markProfileQuestionUnknown,
  updateCompanyProfileField,
} from "@cunote/core";
import { normalizeManualProfile } from "@/lib/server/teaser/resolveTeaserCompanyProfile";

const OPERATIONAL_DIMENSIONS = new Set<string>(OPERATIONAL_PROFILE_DIMENSIONS);
const MAX_ANSWERS_PER_REQUEST = 64;

export class ProductProfileAnswerError extends Error {
  readonly status = 400;

  constructor(
    readonly code: string,
    message: string,
    readonly field = "answers",
  ) {
    super(message);
    this.name = "ProductProfileAnswerError";
  }
}

export function normalizeProductProfileAnswers(input: {
  asOf: string;
  answers?: readonly MatchingProfileAnswerRequest[];
  legacyProfile?: CompanyProfile;
}): CompanyProfile {
  const asOf = requireIsoTimestamp(input.asOf);
  if (input.answers !== undefined && !Array.isArray(input.answers)) {
    throw new ProductProfileAnswerError("invalid_profile_answers", "answers는 배열이어야 합니다.");
  }
  if (input.legacyProfile !== undefined && !isRecord(input.legacyProfile)) {
    throw new ProductProfileAnswerError("invalid_legacy_profile", "profile은 객체여야 합니다.", "profile");
  }
  const answers = input.answers ?? [];
  if (answers.length > MAX_ANSWERS_PER_REQUEST) {
    throw new ProductProfileAnswerError(
      "too_many_profile_answers",
      `한 요청에는 답변을 ${MAX_ANSWERS_PER_REQUEST}개까지 반영할 수 있습니다.`,
    );
  }

  let profile = input.legacyProfile
    ? normalizeManualProfile(input.legacyProfile as unknown as Record<string, unknown>, { asOf })
    : {};
  for (const [index, answer] of answers.entries()) {
    if (!isRecord(answer) || typeof answer.field !== "string") {
      throw invalidAnswer(index, "field가 필요합니다.");
    }
    if (!OPERATIONAL_DIMENSIONS.has(answer.field)) {
      throw new ProductProfileAnswerError(
        "unsupported_profile_field",
        `${answer.field}은(는) 익명 매칭 답변으로 지원하지 않습니다.`,
        `answers.${index}.field`,
      );
    }
    const field = answer.field as MatchingProfileAnswerRequest["field"];
    if (answer.mode !== undefined && answer.mode !== "replace" && answer.mode !== "merge") {
      throw new ProductProfileAnswerError(
        "invalid_profile_answer_mode",
        "mode는 replace 또는 merge여야 합니다.",
        `answers.${index}.mode`,
      );
    }
    const hasValue = Object.hasOwn(answer, "value");
    const hasUnknown = answer.unknown === true;
    const hasRange = answer.range !== undefined;
    if (Number(hasValue) + Number(hasUnknown) + Number(hasRange) !== 1) {
      throw new ProductProfileAnswerError(
        "ambiguous_profile_answer",
        "value, unknown, range 중 하나만 보내야 합니다.",
        `answers.${index}`,
      );
    }

    try {
      if (hasUnknown) {
        profile = markProfileQuestionUnknown({
          profile,
          dimension: field,
          answeredAt: new Date(asOf),
        });
        continue;
      }
      if (hasRange) {
        if (
          (field !== "revenue" && field !== "employees") ||
          !isValidRange(field, answer.range)
        ) {
          throw new ProductProfileAnswerError(
            "invalid_profile_range",
            "매출·근로자 구간이 올바르지 않습니다.",
            `answers.${index}.range`,
          );
        }
        profile = markProfileQuestionRange({
          profile,
          dimension: field,
          range: answer.range,
          answeredAt: new Date(asOf),
        });
        continue;
      }
      profile = updateCompanyProfileField(profile, {
        field,
        value: answer.value,
        confidence: 0.6,
        mode: answer.mode ?? "replace",
        sourceKind: "self_declared",
        provider: "cunote_teaser_answer",
        asOf,
      });
    } catch (error) {
      if (error instanceof ProductProfileAnswerError) throw error;
      throw new ProductProfileAnswerError(
        "invalid_profile_answer",
        error instanceof Error ? error.message : "답변을 정규화하지 못했습니다.",
        `answers.${index}`,
      );
    }
  }
  return profile;
}

function isValidRange(
  dimension: "revenue" | "employees",
  value: unknown,
): value is { min: number; max: number | null; unit: "krw" | "people" } {
  if (!isRecord(value)) return false;
  if (typeof value.min !== "number" || !Number.isFinite(value.min) || value.min < 0) return false;
  if (value.max !== null && (typeof value.max !== "number" || !Number.isFinite(value.max) || value.max < value.min)) {
    return false;
  }
  return value.unit === (dimension === "revenue" ? "krw" : "people");
}

function requireIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new ProductProfileAnswerError("invalid_as_of", "asOf가 올바르지 않습니다.", "asOf");
  }
  return parsed.toISOString();
}

function invalidAnswer(index: number, message: string): ProductProfileAnswerError {
  return new ProductProfileAnswerError("invalid_profile_answer", message, `answers.${index}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

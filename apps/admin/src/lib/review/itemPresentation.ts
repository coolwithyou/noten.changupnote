interface PresentableReviewItem {
  itemKind: "criterion" | "axis" | "question_check"
  collectTarget: "audit_file" | "overlay"
  dimension: string | null
  blind: boolean
  payload: Record<string, unknown>
}

export interface ReviewItemPresentation {
  title: string
  dimensionLabel: string
  kindLabel: string
  question: string
  extractedValue: string | null
  evidence: string | null
  context: Array<{ label: string; value: string }>
}

const DIMENSION_LABELS: Record<string, string> = {
  region: "지역·소재지",
  biz_age: "업력",
  industry: "업종·분야",
  size: "기업 규모",
  revenue: "매출",
  employees: "상시근로자 수",
  founder_age: "대표자 연령",
  founder_trait: "대표자 특성",
  certification: "보유 인증",
  prior_award: "수상·선정 및 기수혜 이력",
  ip: "지식재산",
  target_type: "신청 대상",
  business_status: "사업 상태",
  tax_compliance: "세금 체납",
  credit_status: "신용 상태",
  sanction: "제재·참여 제한",
  financial_health: "재무 건전성",
  insured_workforce: "고용보험 피보험자",
  investment: "투자 유치",
  premises: "사업장·입지",
  export_performance: "수출 실적",
  other: "기타 조건",
}

const KIND_LABELS: Record<string, string> = {
  required: "필수 조건",
  preferred: "우대 조건",
  exclusion: "제외 조건",
}

const OPERATOR_LABELS: Record<string, string> = {
  in: "목록 중 하나",
  not_in: "목록에 해당하지 않음",
  eq: "일치",
  neq: "불일치",
  gte: "이상",
  lte: "이하",
  between: "범위",
  exists: "보유",
  not_exists: "미보유",
}

const REASON_LABELS: Record<string, string> = {
  ai_non_correct: "AI 검수에서 정확 판정이 나오지 않아 재확인이 필요합니다.",
  correct_sample: "AI 정확 판정의 품질을 확인하는 표본입니다.",
  missed_condition: "원문 조건이 분석에서 누락됐을 가능성이 있습니다.",
  low_confidence: "AI 분석 신뢰도가 낮아 원문 확인이 필요합니다.",
  span_unverified: "인용 근거가 원문에서 확인되지 않아 재확인이 필요합니다.",
}

export function reviewDimensionLabel(dimension: string | null): string {
  if (!dimension) return "검수 항목"
  return DIMENSION_LABELS[dimension] ?? humanizeIdentifier(dimension)
}

export function buildReviewItemPresentation(
  item: PresentableReviewItem,
): ReviewItemPresentation {
  const criterion = recordValue(item.payload.criterion)
  const dimension = item.dimension ?? stringValue(criterion?.dimension)
  const dimensionLabel = reviewDimensionLabel(dimension)
  const kind = stringValue(criterion?.kind)
  const kindLabel = item.itemKind === "axis"
    ? "누락 가능성 확인"
    : item.itemKind === "question_check"
      ? "확인 질문 검토"
      : KIND_LABELS[kind ?? ""] ?? "조건 판정"
  const extractedValue = describeCriterionValue(criterion?.value)
    ?? describeCriterionValue(item.payload.value)
  const evidence = firstText(
    criterion?.sourceSpan,
    criterion?.rawText,
    item.payload.sourceSpan,
    item.payload.rawText,
  )
  const question = buildQuestion({
    itemKind: item.itemKind,
    blind: item.blind,
    dimensionLabel,
    kindLabel,
    extractedValue,
  })
  const context: Array<{ label: string; value: string }> = []
  const operator = stringValue(criterion?.operator)
  const confidence = numberValue(criterion?.confidence) ?? numberValue(item.payload.confidence)
  const reasons = stringArray(item.payload.reasons)
  const reason = stringValue(item.payload.reason)

  if (operator) context.push({ label: "판정 방식", value: OPERATOR_LABELS[operator] ?? humanizeIdentifier(operator) })
  if (confidence != null) context.push({ label: "AI 신뢰도", value: `${Math.round(confidence * 100)}%` })
  for (const value of reason ? [reason] : reasons) {
    context.push({ label: "검수 대상이 된 이유", value: REASON_LABELS[value] ?? humanizeIdentifier(value) })
  }

  return {
    title: dimensionLabel,
    dimensionLabel,
    kindLabel,
    question,
    extractedValue,
    evidence,
    context,
  }
}

function buildQuestion(input: {
  itemKind: PresentableReviewItem["itemKind"]
  blind: boolean
  dimensionLabel: string
  kindLabel: string
  extractedValue: string | null
}): string {
  const value = input.extractedValue ? `“${input.extractedValue}”` : "표시된 조건"
  if (input.itemKind === "axis") {
    return input.blind
      ? `공고 원문에 ${input.dimensionLabel} 조건이 실제로 있는데 분석에서 빠졌나요?`
      : `AI는 ${input.dimensionLabel} 조건이 분석에서 누락됐을 가능성이 있다고 봤습니다. 공고 원문에 실제 조건이 있나요?`
  }
  if (input.itemKind === "question_check") {
    return `이 공고를 정확히 판단하려면 ${input.dimensionLabel}에 관한 추가 확인 질문이 필요한가요?`
  }
  return input.blind
    ? `공고 원문에서 ${input.dimensionLabel} 조건을 ${value}로 실제 요구하나요?`
    : `AI 분석: 이 공고의 ${input.dimensionLabel} 조건은 ${value}이며 ${input.kindLabel}입니다. 공고 원문에서도 실제로 이렇게 요구하나요?`
}

function describeCriterionValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "해당" : "해당 없음"
  if (Array.isArray(value)) {
    const entries = value
      .map(describeCriterionValue)
      .filter((entry): entry is string => Boolean(entry))
    return entries.length ? entries.slice(0, 8).join(", ") : null
  }
  const record = recordValue(value)
  if (!record) return null

  for (const key of [
    "labels",
    "tags",
    "values",
    "regions",
    "industries",
    "sizes",
    "traits",
    "certifications",
    "programs",
    "targets",
    "types",
    "exceptions",
  ]) {
    const described = describeCriterionValue(record[key])
    if (described) return described
  }

  const min = scalarValue(record.min ?? record.minimum ?? record.minMonths)
  const max = scalarValue(record.max ?? record.maximum ?? record.maxMonths)
  if (min != null && max != null) return `${min}~${max}`
  if (min != null) return `${min} 이상`
  if (max != null) return `${max} 이하`

  const compact = Object.entries(record)
    .filter(([key]) => !["dimension", "kind", "operator", "sourceSpan", "rawText", "confidence"].includes(key))
    .map(([key, entry]) => {
      const described = describeCriterionValue(entry)
      return described ? `${humanizeIdentifier(key)}: ${described}` : null
    })
    .filter((entry): entry is string => Boolean(entry))
  return compact.length ? compact.slice(0, 4).join(" · ") : null
}

function scalarValue(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)
    if (text) return text
  }
  return null
}

function humanizeIdentifier(value: string): string {
  return value.replaceAll("_", " ")
}

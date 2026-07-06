/**
 * 지식 루프 Step 3 — 승인 lesson 을 공고(지원 준비 화면)에 매칭하는 소비 계층.
 *
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §6.3(주입)·§3(준비 탭 노출 가치).
 * 저장 로직은 knowledgeRepo(listLessons)가 단일 원천이며, 여기서는 그 결과를
 * "이 공고에 노출할 유의사항"으로 좁혀 JSON-safe 뷰 모델(GrantLessonGuideDto)로 변환한다.
 *
 * 핵심 원칙(계획 §6):
 *   - 매칭은 보수적으로: scope 에 program/institution 축이 있고 그 값이 공고 텍스트에
 *     실제로 나타날 때만 노출한다(LIPS 지식이 전 사업에 새는 과일반화 방지).
 *   - fieldPattern/condition 만 있는 lesson 은 grant 레벨에서 노출하지 않는다
 *     (필드 레벨 주입은 후속 — Phase 5 fill planner).
 *   - evidenceTier 는 함께 표기해 확신 수준을 구분한다("담당자 확인"은 공식 규정 우선).
 *   - reviewBy 도래는 자동 만료가 아니라 needsReview 재검토 신호일 뿐이다.
 */
import {
  listLessons,
  type EvidenceTier,
  type LessonScope,
  type LessonTarget,
  type ReviewLessonRow,
} from "./knowledgeRepo";

// ── 노출 뷰 모델(클라이언트로 전달, Date → ISO) ─────────────────
export interface GrantLessonItemDto {
  id: string;
  instruction: string;
  rationale: string;
  evidenceTier: EvidenceTier;
  /** reviewBy 가 지난 lesson(자동 만료 아님 — 재검토 신호). */
  needsReview: boolean;
  programRound: string | null;
  reviewBy: string | null;
}
export interface GrantLessonGroupDto {
  target: LessonTarget;
  lessons: GrantLessonItemDto[];
}
export interface GrantLessonGuideDto {
  matched: boolean;
  total: number;
  groups: GrantLessonGroupDto[];
}

// ── target 노출 순서 — 자격·수치가 먼저(계획 §3). 목록 밖 target 은 뒤에 안정적으로 붙인다. ──
const GROUP_ORDER: readonly LessonTarget[] = [
  "criteria",
  "fill_value",
  "field_interpretation",
  "guide",
  "evaluation",
];

// ── 프로그램 별칭 사전(확장 가능) — 한↔영·표기 변형을 한 그룹으로 묶는다. ──
// 토큰이 어느 그룹에 속하면 그룹 전체를 공고 텍스트에서 탐색한다(LIPS ⇒ "LIPS"·"립스" 모두).
const PROGRAM_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["LIPS", "립스"],
  ["TIPS", "팁스"],
  ["PRE-TIPS", "PRETIPS", "프리팁스", "프리립스"],
];

/** 대소문자·공백·하이픈·가운뎃점을 제거해 포함 검사를 안정화한다(NFKC 로 전각/변형 흡수). */
// export: lessonContext.test.ts 가 라벨 정규화를 재현하기 위해 사용(내부 헬퍼).
export function norm(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[\s\-·]/g, "");
}

/** scope.program 을 "/"·공백·"·" 로 토큰화. */
function tokenizeProgram(program: string): string[] {
  return program
    .split(/[/\s·]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** 프로그램 토큰을 별칭 그룹으로 확장(그룹 없으면 자기 자신만). */
function expandProgramAliases(token: string): readonly string[] {
  const key = norm(token);
  for (const group of PROGRAM_ALIAS_GROUPS) {
    if (group.some((alias) => norm(alias) === key)) return group;
  }
  return [token];
}

/** program 축 매칭: 토큰 1개라도 별칭 확장 후 공고 텍스트에 포함되면 성립. */
function programMatches(program: string, grantNorm: string): boolean {
  for (const token of tokenizeProgram(program)) {
    for (const alias of expandProgramAliases(token)) {
      const needle = norm(alias);
      if (needle.length > 0 && grantNorm.includes(needle)) return true;
    }
  }
  return false;
}

/** institution 축 매칭: 기관명이 공고 텍스트(title+agency)에 포함되면 성립. */
function institutionMatches(institution: string, grantNorm: string): boolean {
  const needle = norm(institution);
  return needle.length > 0 && grantNorm.includes(needle);
}

/** scope 에서 비어있지 않은 문자열 축만 뽑는다. */
function axisValue(scope: LessonScope, key: keyof LessonScope): string | null {
  const value = scope?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 공고 레벨 1차 게이트: 발효 시효 + program/institution 축이 공고 텍스트에 매칭되는가.
 * grant 레벨 노출(matchApprovedLessonsForGrant)과 필드 팁(matchFieldLessonTips)이
 * 동일한 관문을 공유한다(LIPS 지식이 무관 사업으로 새는 과일반화 방지 — 단일 원천).
 */
function passesGrantGate(lesson: ReviewLessonRow, grantNorm: string, now: number): boolean {
  // 시효: 아직 발효 전(validFrom 미래)인 lesson 은 노출하지 않는다.
  if (lesson.validFrom && new Date(lesson.validFrom).getTime() > now) return false;

  const scope = (lesson.scope ?? {}) as LessonScope;
  const program = axisValue(scope, "program");
  const institution = axisValue(scope, "institution");

  // program/institution 축이 하나도 없으면 공고 레벨 노출 대상이 아니다.
  if (!program && !institution) return false;

  const byProgram = program ? programMatches(program, grantNorm) : false;
  const byInstitution = institution ? institutionMatches(institution, grantNorm) : false;
  return byProgram || byInstitution;
}

/**
 * 공고에 매칭되는 승인 lesson 을 target 그룹으로 묶어 반환한다.
 * - listLessons({ status: "approved" }) 전량 로드 후 JS 매칭(수십 건 규모 — 과공학 금지).
 * - validFrom > now 는 제외. reviewBy < now 는 제외하지 않되 needsReview 플래그.
 */
export async function matchApprovedLessonsForGrant(input: {
  title: string;
  agency: string | null;
}): Promise<GrantLessonGuideDto> {
  const grantNorm = norm([input.title, input.agency ?? ""].join(" "));
  const now = Date.now();

  const approved = await listLessons({ status: "approved" });

  const matched = approved.filter((lesson) => passesGrantGate(lesson, grantNorm, now));

  // target 그룹으로 묶고 GROUP_ORDER 로 정렬(목록 밖 target 은 뒤에).
  const byTarget = new Map<LessonTarget, GrantLessonItemDto[]>();
  for (const lesson of matched) {
    const item: GrantLessonItemDto = {
      id: lesson.id,
      instruction: lesson.instruction,
      rationale: lesson.rationale,
      evidenceTier: lesson.evidenceTier,
      needsReview: lesson.reviewBy ? new Date(lesson.reviewBy).getTime() < now : false,
      programRound: lesson.programRound,
      reviewBy: lesson.reviewBy ? new Date(lesson.reviewBy).toISOString() : null,
    };
    const bucket = byTarget.get(lesson.target);
    if (bucket) bucket.push(item);
    else byTarget.set(lesson.target, [item]);
  }

  const orderedTargets = [
    ...GROUP_ORDER.filter((target) => byTarget.has(target)),
    ...[...byTarget.keys()].filter((target) => !GROUP_ORDER.includes(target)),
  ];
  const groups: GrantLessonGroupDto[] = orderedTargets.map((target) => ({
    target,
    lessons: byTarget.get(target) ?? [],
  }));

  return { matched: matched.length > 0, total: matched.length, groups };
}

// ── 필드 레벨 팁(지식 루프 Step 3 두 번째 슬라이스 + K2 fieldKey 격상) ────────────────
// 지원서 작성 시점에, 승인 lesson 이 입력 항목에 매칭되면 그 항목 바로 옆에 '작성 팁'으로 노출한다.
// K2 이후 매칭 축이 둘이다: (1) scope.fieldKey ↔ 필드 fieldKey 동등성(Gate 1 표준 key — 우선),
// (2) scope.fieldPattern ↔ 라벨 문자열 포함(폴백). 자세한 규칙은 fieldLessonMatches 주석 참조.

/** 한 입력 항목(라벨)에 붙는 팁 1건(클라이언트로 전달, JSON-safe). */
export interface FieldLessonTip {
  id: string;
  instruction: string;
  rationale: string;
  target: LessonTarget;
  evidenceTier: EvidenceTier;
  /** reviewBy 가 지난 lesson(자동 만료 아님 — 재검토 신호). */
  needsReview: boolean;
}
export interface FieldLessonTipsDto {
  matched: boolean;
  /** 원본 라벨 → 그 라벨에 매칭된 팁 목록(매칭된 라벨만 키로 존재). */
  byLabel: Record<string, FieldLessonTip[]>;
}

// ── 라벨당 팁 정렬 순서 — 수치·해석(기입값·필드 해석)이 팁 가치 최상. ──
const FIELD_TIP_TARGET_ORDER: readonly LessonTarget[] = [
  "fill_value",
  "field_interpretation",
  "guide",
  "evaluation",
  "criteria",
  "classification",
];
function fieldTipTargetRank(target: LessonTarget): number {
  const index = FIELD_TIP_TARGET_ORDER.indexOf(target);
  return index === -1 ? FIELD_TIP_TARGET_ORDER.length : index;
}

/** fieldPattern 을 "/"·"·"·공백류로 토큰화(라벨과 대조할 최소 단위). */
function tokenizeFieldPattern(pattern: string): string[] {
  return pattern
    .split(/[/·\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * fieldPattern 이 라벨에 매칭되는가(보수적):
 * 토큰을 grant 레벨과 같은 정규화(NFKC·대문자·공백류 제거) 후, 라벨(정규화)에 포함되면 성립.
 * 정규화 길이 2 미만 토큰은 무시한다(단문자 과매칭 방지).
 */
// export: lessonContext.test.ts 의 폴백 회귀 검증에 사용(내부 헬퍼).
export function fieldPatternMatchesLabel(pattern: string, labelNorm: string): boolean {
  for (const token of tokenizeFieldPattern(pattern)) {
    const needle = norm(token);
    if (needle.length < 2) continue;
    if (labelNorm.includes(needle)) return true;
  }
  return false;
}

/** 매칭 대상 입력 필드 1개(라벨 필수, fieldKey 는 서식 필드에만 존재). */
export interface FieldInput {
  label: string;
  fieldKey?: string | null;
}

/** 후보 lesson 의 scope 매칭 축(정규화된 문자열, 없으면 null). */
interface FieldLessonCandidateAxes {
  fieldKey: string | null;
  fieldPattern: string | null;
}

/**
 * 필드 팁 매칭 판정(순수 함수 — DB 없이 유닛 테스트 대상, lessonContext.test.ts).
 *
 * 매칭 규칙(후보 lesson 은 이미 1차 게이트 통과 && fieldKey 또는 fieldPattern 보유):
 *   1) lesson·field 양쪽 다 fieldKey 보유 → 동등성만으로 판정한다.
 *      일치=매칭, 불일치=매칭 안 함. 양쪽 다 Gate 1 표준 사전 기반이므로 불일치는 진짜 다른
 *      필드이며, 여기서 fieldPattern 문자열 폴백으로 내려가지 않는다(오탐 재유입 금지).
 *      → "직원 수"↔"상시근로자 수" 문자열 미탐이 fieldKey=employee_count 동등성으로 잡히는 것이 목적.
 *   2) 그 외(어느 한쪽이라도 fieldKey 없음) → 기존 fieldPattern 문자열 포함 폴백.
 *      lesson 에 fieldPattern 이 없으면 매칭 안 함.
 */
export function fieldLessonMatches(
  lesson: FieldLessonCandidateAxes,
  field: { fieldKey: string | null; labelNorm: string },
): boolean {
  // (1) 양쪽 다 fieldKey → 동등성 단독 판정(불일치 시 폴백 없음).
  if (lesson.fieldKey && field.fieldKey) {
    return lesson.fieldKey === field.fieldKey;
  }
  // (2) 폴백: fieldPattern 문자열 포함(fieldPattern 없으면 매칭 안 함).
  if (!lesson.fieldPattern) return false;
  return fieldPatternMatchesLabel(lesson.fieldPattern, field.labelNorm);
}

/**
 * 입력 항목(라벨 + 선택 fieldKey)들에 매칭되는 승인 lesson 을 라벨별 팁으로 조립한다.
 * - 1차 게이트는 공고 레벨과 동일(passesGrantGate) — LIPS/TIPS 등 program/institution 이 공고에 실재할 때만.
 * - 2차는 fieldLessonMatches: scope.fieldKey 동등성 우선, scope.fieldPattern 문자열 포함 폴백.
 * - fields 중복 제거는 label 기준(같은 label 이 프로필 질문·서식 필드로 중복 유입될 수 있음).
 *   같은 label 에 fieldKey 유무가 갈리면 fieldKey 있는 쪽을 우선 채택한다.
 * - 출력 byLabel 형태는 K1 노출 텔레메트리가 그대로 소비하므로 변경하지 않는다.
 */
export async function matchFieldLessonTips(input: {
  title: string;
  agency: string | null;
  fields: FieldInput[];
}): Promise<FieldLessonTipsDto> {
  const grantNorm = norm([input.title, input.agency ?? ""].join(" "));
  const now = Date.now();

  // 원본 라벨 → { 정규화 라벨, fieldKey }. label 기준 중복 제거, fieldKey 있는 쪽 우선, 빈 라벨 무시.
  const fieldMap = new Map<string, { labelNorm: string; fieldKey: string | null }>();
  for (const raw of input.fields) {
    const label = typeof raw?.label === "string" ? raw.label.trim() : "";
    if (!label) continue;
    const fieldKey =
      typeof raw.fieldKey === "string" && raw.fieldKey.trim().length > 0 ? raw.fieldKey.trim() : null;
    const existing = fieldMap.get(label);
    if (!existing) {
      fieldMap.set(label, { labelNorm: norm(label), fieldKey });
    } else if (!existing.fieldKey && fieldKey) {
      existing.fieldKey = fieldKey; // 같은 label — fieldKey 있는 쪽 우선.
    }
  }
  if (fieldMap.size === 0) return { matched: false, byLabel: {} };

  const approved = await listLessons({ status: "approved" });

  // 1차 게이트 통과 + (fieldKey 또는 fieldPattern) 보유 lesson 만 후보로 남긴다.
  const candidates = approved
    .filter((lesson) => passesGrantGate(lesson, grantNorm, now))
    .map((lesson) => {
      const scope = (lesson.scope ?? {}) as LessonScope;
      return {
        lesson,
        fieldKey: axisValue(scope, "fieldKey"),
        fieldPattern: axisValue(scope, "fieldPattern"),
      };
    })
    .filter((candidate) => candidate.fieldKey !== null || candidate.fieldPattern !== null);

  const byLabel: Record<string, FieldLessonTip[]> = {};
  for (const [label, field] of fieldMap) {
    const tips: FieldLessonTip[] = [];
    for (const candidate of candidates) {
      if (!fieldLessonMatches(candidate, { fieldKey: field.fieldKey, labelNorm: field.labelNorm })) {
        continue;
      }
      const lesson = candidate.lesson;
      tips.push({
        id: lesson.id,
        instruction: lesson.instruction,
        rationale: lesson.rationale,
        target: lesson.target,
        evidenceTier: lesson.evidenceTier,
        needsReview: lesson.reviewBy ? new Date(lesson.reviewBy).getTime() < now : false,
      });
    }
    if (tips.length === 0) continue;
    // fill_value·field_interpretation 을 앞으로(수치·해석 우선). Array.sort 는 안정 정렬.
    tips.sort((a, b) => fieldTipTargetRank(a.target) - fieldTipTargetRank(b.target));
    byLabel[label] = tips;
  }

  return { matched: Object.keys(byLabel).length > 0, byLabel };
}

// ── Phase 5 LLM 주입용 선행(계획 §6.3) ────────────────────────────
// 이번 UI 슬라이스는 사용하지 않지만, fill planner / draft 프롬프트가 승인 lesson 을
// 컨텍스트로 주입할 때 재사용할 순수 함수다. evidenceTier 를 함께 표기해 모델이 확신
// 수준을 구분하게 한다(계획 §6: "주입 시 tier 를 함께 표기").
//
// 사용 예:
//   const lessons = await listLessons({ status: "approved" });
//   const block = buildLessonPromptBlock(lessons);
//   // → draft 프롬프트의 시스템/컨텍스트 슬롯에 그대로 삽입

/** buildLessonPromptBlock 이 요구하는 최소 형태(ReviewLessonRow 도 그대로 받는다). */
export type PromptBlockLesson = Pick<
  ReviewLessonRow,
  "target" | "evidenceTier" | "instruction" | "rationale"
>;

const TARGET_LABEL_KO: Record<LessonTarget, string> = {
  classification: "분류",
  criteria: "자격·전제조건",
  field_interpretation: "필드 해석",
  fill_value: "기입값·한도",
  guide: "작성 지침",
  evaluation: "심사 관점",
};
const EVIDENCE_TIER_LABEL_KO: Record<EvidenceTier, string> = {
  official_document: "공식 문서",
  staff_confirmed: "담당자 확인",
  ops_inference: "운영 추정",
};

/**
 * 승인 lesson 배열 → LLM 프롬프트 주입 블록 문자열.
 * 헤더에 evidenceTier 우선순위 규칙을 명시하고, 각 lesson 을
 * "- [target/evidenceTier] instruction (근거: rationale)" 한 줄로 나열한다.
 */
export function buildLessonPromptBlock(lessons: PromptBlockLesson[]): string {
  if (lessons.length === 0) return "";
  const header =
    "다음은 운영팀이 검증한 지침이다. evidenceTier가 '담당자 확인'인 항목은 공식 규정과 충돌 시 공식 규정이 우선한다.";
  const lines = lessons.map((lesson) => {
    const target = TARGET_LABEL_KO[lesson.target] ?? lesson.target;
    const tier = EVIDENCE_TIER_LABEL_KO[lesson.evidenceTier] ?? lesson.evidenceTier;
    return `- [${target}/${tier}] ${lesson.instruction.trim()} (근거: ${lesson.rationale.trim()})`;
  });
  return [header, "", ...lines].join("\n");
}

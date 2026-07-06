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
function norm(value: string): string {
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

  const matched = approved.filter((lesson) => {
    // 시효: 아직 발효 전(validFrom 미래)인 lesson 은 노출하지 않는다.
    if (lesson.validFrom && new Date(lesson.validFrom).getTime() > now) return false;

    const scope = (lesson.scope ?? {}) as LessonScope;
    const program = axisValue(scope, "program");
    const institution = axisValue(scope, "institution");

    // program/institution 축이 하나도 없으면 grant 레벨 노출 대상이 아니다.
    if (!program && !institution) return false;

    const byProgram = program ? programMatches(program, grantNorm) : false;
    const byInstitution = institution ? institutionMatches(institution, grantNorm) : false;
    return byProgram || byInstitution;
  });

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

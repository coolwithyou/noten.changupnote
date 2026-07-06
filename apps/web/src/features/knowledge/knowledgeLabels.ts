/**
 * 지식 대시보드 클라이언트 뷰가 공유하는 라벨·서식 유틸.
 *
 * LessonInboxView 선례를 따른다: 서버(drizzle) 모듈을 클라이언트 번들로 끌어오지 않기 위해
 * 도메인 union 타입은 여기서 로컬로 좁혀 쓰고, 값 수준 상수(라벨 맵)도 로컬로 둔다.
 * DTO 형태(KnowledgeDashboardData 등)는 각 컴포넌트가 `import type` 으로만 참조한다(런타임 의존 0).
 */

// ── 로컬 도메인 union (knowledgeRepo 와 리터럴 동일) ─────────────
export type LessonStatus = "proposed" | "approved" | "rejected" | "retired";
export type LessonTarget =
  | "classification"
  | "criteria"
  | "field_interpretation"
  | "fill_value"
  | "guide"
  | "evaluation";
export type EvidenceTier = "official_document" | "staff_confirmed" | "ops_inference";
export type KnowledgeSourceKind =
  | "ops_interview"
  | "user_feedback_report"
  | "official_announcement"
  | "program_faq";
export type KnowledgeSourceStatus = "registered" | "extracted" | "curated";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "ghost";

// ── 공용 배너(상단 알림) 타입 ──────────────────────────────────
export type DashboardBanner = { kind: "ok" | "error" | "warn"; text: string } | null;
export type SetBanner = (banner: DashboardBanner) => void;

// ── lesson status ─────────────────────────────────────────────
/** 지표 부기 순서(승인 → 제안 → 기각 → 철회). */
export const LESSON_STATUS_ORDER: LessonStatus[] = ["approved", "proposed", "rejected", "retired"];
/** 짧은 라벨(카드 부기용). */
export const LESSON_STATUS_LABEL: Record<LessonStatus, string> = {
  approved: "승인",
  proposed: "제안",
  rejected: "기각",
  retired: "철회",
};

// ── 원천 문서 kind / status ────────────────────────────────────
export const SOURCE_KIND_ORDER: KnowledgeSourceKind[] = [
  "ops_interview",
  "user_feedback_report",
  "official_announcement",
  "program_faq",
];
export const SOURCE_KIND_LABEL: Record<KnowledgeSourceKind, string> = {
  ops_interview: "담당자 인터뷰",
  user_feedback_report: "사용자 피드백",
  official_announcement: "공고 해설",
  program_faq: "프로그램 FAQ",
};

export const SOURCE_STATUS_META: Record<
  KnowledgeSourceStatus,
  { label: string; variant: BadgeVariant }
> = {
  registered: { label: "등록됨", variant: "outline" },
  extracted: { label: "추출됨", variant: "secondary" },
  curated: { label: "큐레이션 완료", variant: "default" },
};

// ── lesson target / evidenceTier ──────────────────────────────
export const TARGET_LABEL: Record<LessonTarget, string> = {
  classification: "분류",
  criteria: "자격·전제",
  field_interpretation: "필드 해석",
  fill_value: "기입값",
  guide: "작성 지침",
  evaluation: "심사 관점",
};

export const TIER_META: Record<EvidenceTier, { label: string; warn: boolean }> = {
  official_document: { label: "공식 문서", warn: false },
  staff_confirmed: { label: "담당자 확인", warn: true },
  ops_inference: { label: "운영 추정", warn: true },
};

// ── 비-lesson kind ────────────────────────────────────────────
export const NON_LESSON_KIND_ORDER = ["product_feedback", "faq_candidate", "exemplar"];
export const NON_LESSON_KIND_LABEL: Record<string, string> = {
  product_feedback: "제품 피드백",
  faq_candidate: "FAQ 후보",
  exemplar: "작성 예문",
};

// ── scope 축(reviewDue 칩) ─────────────────────────────────────
export const SCOPE_AXES = [
  "program",
  "institution",
  "formTemplateId",
  "documentCategory",
  "fieldPattern",
  "condition",
] as const;
export type ScopeAxis = (typeof SCOPE_AXES)[number];
export const SCOPE_AXIS_LABEL: Record<ScopeAxis, string> = {
  program: "프로그램",
  institution: "기관",
  formTemplateId: "양식 ID",
  documentCategory: "문서 분류",
  fieldPattern: "필드 패턴",
  condition: "조건",
};

// ── 라벨 조회(폴백 포함) ───────────────────────────────────────
export const labelForTarget = (key: string): string =>
  TARGET_LABEL[key as LessonTarget] ?? key;
export const tierMeta = (key: string): { label: string; warn: boolean } =>
  TIER_META[key as EvidenceTier] ?? { label: key, warn: true };
export const labelForNonLessonKind = (key: string): string =>
  NON_LESSON_KIND_LABEL[key] ?? key;

// ── 서식 유틸 ─────────────────────────────────────────────────
const KOREA_TIME_ZONE = "Asia/Seoul";
const fullDateFmt = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: KOREA_TIME_ZONE,
});
const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: KOREA_TIME_ZONE,
});

/** ISO/날짜 문자열 → "2026년 7월 1일". 파싱 실패 시 "-". */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : fullDateFmt.format(d);
}

/** 날짜 → "HH:MM"(마지막 갱신 표기용). */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : timeFmt.format(d);
}

/** YYYY-MM-DD(UTC 자정) → "MM.DD". TZ 이동을 막기 위해 UTC 필드로 조립. */
export function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}.${dd}`;
}

/** reviewBy 까지의 D-day 라벨. 오늘이면 "D-DAY", 지났으면 "지남". */
export function ddayLabel(iso: string): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "";
  const now = new Date();
  const t0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t1 = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const days = Math.round((t1 - t0) / 86_400_000);
  if (days < 0) return "지남";
  if (days === 0) return "D-DAY";
  return `D-${days}`;
}

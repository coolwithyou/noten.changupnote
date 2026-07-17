// 공모 딥분석 실험실(dev 전용) UI 공용 라벨·포맷 헬퍼.
// contract.ts 의 enum 값을 한국어 라벨과 Badge variant 로 매핑한다.
import type {
  LabAxisStatus,
  LabCriterionKind,
  LabDimensionVerdict,
} from "./contract";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost";

/** 공고 소스 코드 → 표시 라벨. */
export function sourceLabel(source: string): string {
  switch (source) {
    case "kstartup":
      return "K-Startup";
    case "bizinfo":
      return "기업마당";
    default:
      return source;
  }
}

/** criterion kind → 한국어 라벨 (DB 스냅샷은 string 이라 미지의 값은 그대로 노출). */
export function kindLabel(kind: LabCriterionKind | string): string {
  switch (kind) {
    case "required":
      return "필수";
    case "preferred":
      return "우대";
    case "exclusion":
      return "결격";
    default:
      return kind;
  }
}

export function kindBadgeVariant(kind: LabCriterionKind | string): BadgeVariant {
  switch (kind) {
    case "required":
      return "default";
    case "exclusion":
      return "destructive";
    default:
      return "secondary";
  }
}

/** 축 검사 상태(assessment status) 표시 메타. */
export const AXIS_STATUS_META: Record<LabAxisStatus, { label: string; variant: BadgeVariant }> = {
  condition_found: { label: "조건 발견", variant: "default" },
  inspected_no_condition: { label: "검사·조건 없음", variant: "outline" },
  ambiguous: { label: "모호", variant: "secondary" },
  input_missing: { label: "입력 부족", variant: "destructive" },
};

/** 축 단위 A/B 비교 verdict 표시 메타. */
export const VERDICT_META: Record<LabDimensionVerdict, { label: string; variant: BadgeVariant }> = {
  new: { label: "신규 채움", variant: "default" },
  changed: { label: "변경", variant: "secondary" },
  same: { label: "동일", variant: "outline" },
  only_current: { label: "현행만", variant: "outline" },
  none: { label: "양쪽 없음", variant: "ghost" },
};

/** 날짜만 표시 (접수기간 등). 파싱 실패 시 원문 유지. */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 날짜+시각 표시 (런 시작 시각 등). */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 첨부 markdown bytes → 사람이 읽는 크기. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 소요 시간(ms) → "n분 n초" 또는 "n.n초". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}분 ${seconds}초`;
}

export function formatUsd(costUsd: number | null): string {
  if (costUsd === null) return "—";
  return `$${costUsd.toFixed(4)}`;
}

/** criterion value 를 key-value 항목으로 분해 — 블럭 레이아웃에서 raw JSON 대신 줄 단위로 보여준다. */
export interface CriterionValueEntry {
  key: string | null;
  text: string;
}

export function criterionValueEntries(value: unknown): CriterionValueEntry[] {
  if (value === null || value === undefined) return [{ key: null, text: "—" }];
  if (typeof value !== "object") return [{ key: null, text: String(value) }];
  if (Array.isArray(value)) return [{ key: null, text: joinArray(value) }];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [{ key: null, text: "{}" }];
  return entries.map(([key, entry]) => ({
    key,
    text:
      entry === null || entry === undefined
        ? "—"
        : Array.isArray(entry)
          ? joinArray(entry)
          : typeof entry === "object"
            ? safeStringify(entry)
            : String(entry),
  }));
}

function joinArray(items: unknown[]): string {
  if (items.length === 0) return "(빈 목록)";
  return items.map((item) => (typeof item === "object" ? safeStringify(item) : String(item))).join(", ");
}

/** criterion value(unknown JSON) 를 표 셀에 맞게 축약 표시. */
export function formatCriterionValue(value: unknown, maxLength = 140): string {
  if (value === null || value === undefined) return "—";
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : safeStringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

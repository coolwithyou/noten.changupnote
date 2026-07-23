"use client";

import { CheckCircle2, CloudUpload, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudioSavePhase, StudioSaveState } from "@/lib/rhwp/studioSaveState";

export function StudioSaveIndicator({
  state,
  className,
}: {
  state: StudioSaveState;
  className?: string;
}) {
  const presentation = saveStatePresentation(state);
  const Icon = presentation.icon;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs font-medium",
        presentation.className,
        className,
      )}
    >
      <Icon
        className={cn("size-3.5 shrink-0", presentation.spinning && "animate-spin")}
        aria-hidden
      />
      <span className="truncate">{presentation.label}</span>
    </div>
  );
}

function saveStatePresentation(state: StudioSaveState): {
  label: string;
  icon: typeof CheckCircle2;
  className: string;
  spinning?: boolean;
} {
  switch (state.kind) {
    case "legacy-manual":
      return state.lastSavedAt
        ? {
            label: `마지막 서버 저장 ${formatSavedAt(state.lastSavedAt)} · 이후 수정은 다시 저장해 주세요`,
            icon: CheckCircle2,
            className: "text-success",
          }
        : {
            label: "수정 후 직접 저장이 필요해요",
            icon: CloudUpload,
            className: "text-muted-foreground",
          };
    case "dirty":
      return {
        label: "저장되지 않은 변경사항",
        icon: CloudUpload,
        className: "text-amber-700 dark:text-amber-300",
      };
    case "scheduled":
      return {
        label: "변경사항을 곧 자동 저장해요",
        icon: CloudUpload,
        className: "text-amber-700 dark:text-amber-300",
      };
    case "saving":
      return {
        label: savePhaseLabel(state.phase),
        icon: Loader2,
        className: "text-primary",
        spinning: true,
      };
    case "clean":
      return {
        label: `서버에 저장됨 · ${formatSavedAt(state.savedAt)}`,
        icon: CheckCircle2,
        className: "text-success",
      };
    case "tab-only":
      return {
        label: `이 탭에만 임시 저장됨 · ${formatSavedAt(state.savedAt)}`,
        icon: TriangleAlert,
        className: "text-amber-700 dark:text-amber-300",
      };
    case "error":
      return {
        label: state.hasTabSnapshot
          ? "서버 저장 실패 · 이 탭에는 임시 보관됨"
          : "저장하지 못했습니다",
        icon: TriangleAlert,
        className: "text-destructive",
      };
  }
}

function savePhaseLabel(phase: StudioSavePhase) {
  if (phase === "exporting") return "Studio 문서를 내보내는 중…";
  if (phase === "verifying") return "문서를 검증하는 중…";
  return "서버에 저장하는 중…";
}

function formatSavedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

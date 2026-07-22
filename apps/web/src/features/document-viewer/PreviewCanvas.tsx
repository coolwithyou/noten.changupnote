"use client";

/**
 * 재사용 가능한 문서 프리뷰 캔버스 (Apply Experience v2 · §4.3 — DocumentPreviewView 를 분해해 추출).
 *
 * rhwp 원본 SVG(실패 시 페이지 이미지) + 필드 오버레이 + 줌/페이지 내비를 담당한다. 오버레이는 필드별 상태색(4종 + plain)을
 * 파라미터로 받는다. `selectedFieldId` 가 바뀌면 그 필드의 페이지로 이동해 카드↔오버레이 양방향 동기화를
 * 이룬다. `box` 가 null 인 필드는 오버레이를 그리지 않는다(카드 전용).
 *
 * /grants/[grantId]/preview 의 DocumentPreviewView 도 이 컴포넌트를 쓴다 — 그때는 모든 필드에 `plain`
 * 상태를 주어 기존 단색(primary) 오버레이가 시각적으로 회귀하지 않게 한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { boxToPercentStyle, type NormalizedBox } from "@/lib/documents/bbox";
import type { RhwpFieldAnchor, RhwpFieldDescriptor } from "@/lib/rhwp/fieldAnchors";
import type { PreviewPage } from "@/lib/server/documents/documentPreview";
import { RhwpPageSurface } from "./RhwpPageSurface";

/** 오버레이 시각 상태. plain 은 /preview 의 기존 단색 오버레이 재현용. */
export type PreviewOverlayState = "plain" | "empty" | "suggested" | "confirmed" | "warning";

export interface PreviewOverlayField {
  fieldId: string;
  label: string;
  /** 1-based 페이지. null 이면 위치 미확인(오버레이 없음). */
  page: number | null;
  box: NormalizedBox | null;
  state: PreviewOverlayState;
  /** 확정(confirmed)된 값 — 오버레이 안에 실제 기입처럼 렌더한다(재정의 R2). */
  value?: string | null;
  /** 기존 좌표의 생성 근거. rhwp 모드에서는 신뢰 가능한 구조 좌표만 폴백 표시한다. */
  visualEvidence?: Record<string, unknown> | null;
}

type RhwpPreviewState =
  | { status: "inactive" | "loading" | "fallback" }
  | { status: "ready"; pageCount: number; anchors: RhwpFieldAnchor[] };

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

// 상태별 오버레이 톤(전부 시맨틱 토큰 — 재정의 R2):
//   empty = hairline outline만(bbox 미스핏이 덜 도드라지게, hover 시만 옅은 틴트)
//   suggested = 옅은 점선 primary / confirmed = success(민트) / warning = warning-strong
//   active(현재 확인 중 셀) = 블루 하이라이트(bg-primary/10). plain 은 /preview 기존 시각 유지.
const OVERLAY_STATE_CLASS: Record<PreviewOverlayState, { base: string; active: string }> = {
  plain: {
    base: "border-primary/60 bg-primary/10 hover:bg-primary/20",
    active: "border-2 border-primary bg-primary/25",
  },
  empty: {
    base: "border border-border bg-transparent hover:bg-primary/5",
    active: "border-2 border-primary bg-primary/10",
  },
  suggested: {
    base: "border border-dashed border-primary/50 bg-primary/5 hover:bg-primary/10",
    active: "border-2 border-dashed border-primary bg-primary/10",
  },
  confirmed: {
    base: "border border-success/50 bg-success/5 hover:bg-success/10",
    active: "border-2 border-success bg-success/10",
  },
  warning: {
    base: "border border-warning-strong/60 bg-warning/10 hover:bg-warning/15",
    active: "border-2 border-warning-strong bg-warning/15",
  },
};

function pageImageUrl(grantId: string, key: string): string {
  const encoded = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/web/grants/${encodeURIComponent(grantId)}/page-image/${encoded}`;
}

export function PreviewCanvas({
  grantId,
  grantTitle,
  pages,
  overlayFields,
  selectedFieldId,
  onSelectField,
  fill = false,
  className,
  rhwpSourceUrl,
  rhwpFields = [],
  manualAnchors = [],
  locatingFieldId = null,
  onLocateField,
  onRhwpAnchorsChange,
}: {
  grantId: string;
  grantTitle: string;
  pages: PreviewPage[];
  overlayFields: PreviewOverlayField[];
  selectedFieldId: string | null;
  onSelectField: (fieldId: string) => void;
  /** true 면 이미지 영역이 부모 높이를 채운다(workspace). false 면 max-h-[80vh](/preview). */
  fill?: boolean;
  className?: string;
  /** 있으면 rhwp 원본 SVG를 우선 렌더하고, 실패 시 기존 페이지 이미지로 폴백한다. */
  rhwpSourceUrl?: string | null;
  /** rhwp 구조 앵커를 계산할 의미 필드. DB bbox는 위치 힌트로만 포함한다. */
  rhwpFields?: readonly RhwpFieldDescriptor[];
  /** 현재 draft 세션에서 사용자가 직접 지정한 구조 셀. */
  manualAnchors?: readonly RhwpFieldAnchor[];
  locatingFieldId?: string | null;
  onLocateField?: (anchor: RhwpFieldAnchor) => void;
  onRhwpAnchorsChange?: (fieldIds: ReadonlySet<string>) => void;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const selectedOverlayRef = useRef<HTMLButtonElement>(null);
  const [rhwpPreview, setRhwpPreview] = useState<RhwpPreviewState>(
    rhwpSourceUrl ? { status: "loading" } : { status: "inactive" },
  );
  const totalPages = rhwpPreview.status === "ready" ? rhwpPreview.pageCount : pages.length;
  const currentPage = pages.find((page) => page.page === pageIndex + 1) ?? null;

  useEffect(() => {
    setRhwpPreview(rhwpSourceUrl ? { status: "loading" } : { status: "inactive" });
    setPageIndex(0);
  }, [rhwpSourceUrl]);

  const handleRhwpReady = useCallback((result: { pageCount: number; anchors: RhwpFieldAnchor[] }) => {
    setRhwpPreview({ status: "ready", pageCount: result.pageCount, anchors: result.anchors });
    onRhwpAnchorsChange?.(new Set(result.anchors.map((anchor) => anchor.fieldId)));
  }, [onRhwpAnchorsChange]);

  const handleRhwpFallback = useCallback(() => {
    setRhwpPreview({ status: "fallback" });
  }, []);

  const locatingField = useMemo(
    () => rhwpFields.find((field) => field.fieldId === locatingFieldId) ?? null,
    [rhwpFields, locatingFieldId],
  );

  const effectiveOverlayFields = useMemo<PreviewOverlayField[]>(() => {
    if (!rhwpSourceUrl) return overlayFields;
    if (rhwpPreview.status === "ready") {
      const anchors = new Map(rhwpPreview.anchors.map((anchor) => [anchor.fieldId, anchor]));
      for (const anchor of manualAnchors) anchors.set(anchor.fieldId, anchor);
      return overlayFields.map((field) => {
        const anchor = anchors.get(field.fieldId);
        return { ...field, page: anchor?.page ?? null, box: anchor?.box ?? null };
      });
    }
    // rhwp 로딩/실패 때 human_review 근사 박스를 원본 위에 그리지 않는다.
    return overlayFields.map((field) => {
      const source = typeof field.visualEvidence?.source === "string" ? field.visualEvidence.source : "";
      const trusted = source.startsWith("rhwp") || source === "layout_json" || source === "ocr_exact";
      return trusted ? field : { ...field, page: null, box: null };
    });
  }, [manualAnchors, overlayFields, rhwpPreview, rhwpSourceUrl]);

  const centerSelectedOverlay = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const overlay = selectedOverlayRef.current;
    if (!viewport || !overlay) return;

    const viewportRect = viewport.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    viewport.scrollTo({
      left:
        viewport.scrollLeft
        + overlayRect.left
        - viewportRect.left
        - (viewport.clientWidth - overlayRect.width) / 2,
      top:
        viewport.scrollTop
        + overlayRect.top
        - viewportRect.top
        - (viewport.clientHeight - overlayRect.height) / 2,
      behavior: "auto",
    });
  }, []);

  // 선택 필드가 바뀌면 그 필드의 페이지로 이동(카드→캔버스 동기화). 좌표 없는 필드는 no-op.
  useEffect(() => {
    if (!selectedFieldId) return;
    const field = effectiveOverlayFields.find((entry) => entry.fieldId === selectedFieldId);
    if (!field || !field.box || !field.page) return;
    if (field.page >= 1 && field.page <= totalPages) setPageIndex(field.page - 1);
  }, [selectedFieldId, effectiveOverlayFields, totalPages]);

  // 문서 전환 등으로 페이지 수가 줄면 인덱스 보정.
  useEffect(() => {
    if (pageIndex > totalPages - 1) setPageIndex(Math.max(0, totalPages - 1));
  }, [totalPages, pageIndex]);

  // 카드 선택/페이지/줌이 바뀌면 현재 셀을 프리뷰 중앙으로 맞춘다. 이미지가 처음 로드되는
  // 순간에도 onLoad 에서 한 번 더 맞춰 모바일의 고정 높이 프리뷰가 빈 상단만 자르지 않게 한다.
  useEffect(() => {
    if (!selectedFieldId) return;
    const frame = requestAnimationFrame(centerSelectedOverlay);
    return () => cancelAnimationFrame(frame);
  }, [centerSelectedOverlay, currentPage?.page, selectedFieldId, zoom]);

  const overlaysForPage = useMemo(
    () => effectiveOverlayFields.filter((field) => field.box && field.page === pageIndex + 1),
    [effectiveOverlayFields, pageIndex],
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-xl)] border bg-card p-4",
        fill ? "h-full min-h-0" : "self-start",
        className,
      )}
    >
      <div
        ref={scrollViewportRef}
        className={cn(
          "overflow-auto rounded-[var(--radius-lg)] bg-secondary",
          fill ? "min-h-0 flex-1" : "max-h-[80vh]",
        )}
      >
        {totalPages > 0 && (currentPage || rhwpPreview.status === "ready") ? (
          // mx-auto: 축소 시 페이지를 가운데로. 확대(>100%)면 margin 0 이 되어 좌측부터 스크롤.
          <div className="relative mx-auto my-4 shadow-[var(--shadow-standard)]" style={{ width: `${zoom * 100}%` }}>
            {rhwpSourceUrl ? (
              <RhwpPageSurface
                sourceUrl={rhwpSourceUrl}
                pageIndex={pageIndex}
                fields={rhwpFields}
                fallbackSrc={currentPage ? pageImageUrl(grantId, currentPage.storageKey) : null}
                alt={`${grantTitle} ${pageIndex + 1}페이지`}
                onLoad={centerSelectedOverlay}
                onReady={handleRhwpReady}
                onFallback={handleRhwpFallback}
                locatingField={locatingField}
                {...(onLocateField ? { onLocate: onLocateField } : {})}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pageImageUrl(grantId, currentPage!.storageKey)}
                alt={`${grantTitle} ${currentPage!.page}페이지`}
                className="pointer-events-none block w-full select-none"
                draggable={false}
                onLoad={centerSelectedOverlay}
              />
            )}
            {overlaysForPage.map((field) => {
              if (!field.box) return null;
              const active = field.fieldId === selectedFieldId;
              const tone = OVERLAY_STATE_CLASS[field.state];
              const confirmedValue =
                field.state === "confirmed" && field.value?.trim() ? field.value.trim() : null;
              return (
                <Button
                  key={field.fieldId}
                  ref={active ? selectedOverlayRef : undefined}
                  variant="ghost"
                  onClick={() => onSelectField(field.fieldId)}
                  title={field.label}
                  aria-label={field.label}
                  className={cn(
                    // 상태색(미입력/제안/확정/확인 필요)이 오버레이의 본질이라 tone 색을 className 으로 덮어쓴다.
                    // p-0 으로 버튼 기본 패딩만 제거하고, 위치·크기는 아래 동적 좌표 style 이 결정한다.
                    "absolute items-start justify-start overflow-hidden rounded-[3px] p-0 text-left whitespace-normal transition-colors",
                    locatingFieldId && "pointer-events-none",
                    active ? tone.active : tone.base,
                  )}
                  // 동적 좌표: 필드 bbox(정규화 %)를 오버레이 위치/크기로 매핑한 계산값이라 인라인 style 유지.
                  style={boxToPercentStyle(field.box)}
                >
                  {confirmedValue ? (
                    // 확정 값은 문서 위 실제 기입처럼(foreground) — 박스보다 길면 클리핑.
                    <span className="flex min-w-0 items-start gap-0.5 overflow-hidden p-0.5 text-[11px] leading-tight font-medium text-foreground">
                      <Check className="size-3 shrink-0 text-success" aria-hidden />
                      <span className="min-w-0 break-words whitespace-pre-wrap">{confirmedValue}</span>
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        ) : (
          <Empty className="min-h-80 border-0">
            <EmptyHeader>
              <EmptyTitle>이 문서의 페이지 이미지가 없습니다.</EmptyTitle>
              <EmptyDescription>변환이 끝나면 페이지 이미지가 여기에 표시됩니다.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>

      {/* 하단 툴바(재정의 R2·스펙 §3): 페이지 네비 ‹ n/N › + 우측 줌 컨트롤만. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="이전 페이지"
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            disabled={pageIndex <= 0}
          >
            <ChevronLeft />
          </Button>
          <Badge variant="outline" className="h-7 min-w-16 justify-center tabular-nums">
            {totalPages > 0 ? `${pageIndex + 1} / ${totalPages}` : "0 / 0"}
          </Badge>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="다음 페이지"
            onClick={() => setPageIndex((index) => Math.min(totalPages - 1, index + 1))}
            disabled={pageIndex >= totalPages - 1}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="축소"
            onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
            disabled={zoom <= ZOOM_MIN}
          >
            <Minus />
          </Button>
          <Badge variant="secondary" className="h-7 min-w-14 justify-center tabular-nums">
            {Math.round(zoom * 100)}%
          </Badge>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="확대"
            onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
            disabled={zoom >= ZOOM_MAX}
          >
            <Plus />
          </Button>
        </div>
      </div>
    </div>
  );
}

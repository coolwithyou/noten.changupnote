"use client";

/**
 * 재사용 가능한 문서 프리뷰 캔버스 (Apply Experience v2 · §4.3 — DocumentPreviewView 를 분해해 추출).
 *
 * 페이지 이미지 + 필드 오버레이 + 줌/페이지 내비를 담당한다. 오버레이는 필드별 상태색(4종 + plain)을
 * 파라미터로 받는다. `selectedFieldId` 가 바뀌면 그 필드의 페이지로 이동해 카드↔오버레이 양방향 동기화를
 * 이룬다. `box` 가 null 인 필드는 오버레이를 그리지 않는다(카드 전용).
 *
 * /grants/[grantId]/preview 의 DocumentPreviewView 도 이 컴포넌트를 쓴다 — 그때는 모든 필드에 `plain`
 * 상태를 주어 기존 단색(primary) 오버레이가 시각적으로 회귀하지 않게 한다.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { boxToPercentStyle, type NormalizedBox } from "@/lib/documents/bbox";
import type { PreviewPage } from "@/lib/server/documents/documentPreview";

/** 오버레이 시각 상태. plain 은 /preview 의 기존 단색 오버레이 재현용. */
export type PreviewOverlayState = "plain" | "empty" | "suggested" | "confirmed" | "warning";

export interface PreviewOverlayField {
  fieldId: string;
  label: string;
  /** 1-based 페이지. null 이면 위치 미확인(오버레이 없음). */
  page: number | null;
  box: NormalizedBox | null;
  state: PreviewOverlayState;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

// 상태별 오버레이 색: 회색(미입력)/파랑 점선(제안 대기)/초록(확정)/노랑(확인 필요). plain=primary.
const OVERLAY_STATE_CLASS: Record<PreviewOverlayState, { base: string; active: string }> = {
  plain: {
    base: "border-primary/60 bg-primary/10 hover:bg-primary/20",
    active: "border-2 border-primary bg-primary/25",
  },
  empty: {
    base: "border-muted-foreground/40 bg-muted-foreground/10 hover:bg-muted-foreground/20",
    active: "border-2 border-muted-foreground bg-muted-foreground/25",
  },
  suggested: {
    base: "border border-dashed border-sky-500/70 bg-sky-500/10 hover:bg-sky-500/20",
    active: "border-2 border-dashed border-sky-500 bg-sky-500/25",
  },
  confirmed: {
    base: "border-emerald-500/70 bg-emerald-500/15 hover:bg-emerald-500/25",
    active: "border-2 border-emerald-500 bg-emerald-500/30",
  },
  warning: {
    base: "border-amber-500/70 bg-amber-500/15 hover:bg-amber-500/25",
    active: "border-2 border-amber-500 bg-amber-500/30",
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
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const totalPages = pages.length;
  const currentPage = pages[pageIndex] ?? null;

  // 선택 필드가 바뀌면 그 필드의 페이지로 이동(카드→캔버스 동기화). 좌표 없는 필드는 no-op.
  useEffect(() => {
    if (!selectedFieldId) return;
    const field = overlayFields.find((entry) => entry.fieldId === selectedFieldId);
    if (!field || !field.box || !field.page) return;
    const targetIndex = pages.findIndex((page) => page.page === field.page);
    if (targetIndex >= 0) setPageIndex(targetIndex);
  }, [selectedFieldId, overlayFields, pages]);

  // 문서 전환 등으로 페이지 수가 줄면 인덱스 보정.
  useEffect(() => {
    if (pageIndex > totalPages - 1) setPageIndex(Math.max(0, totalPages - 1));
  }, [totalPages, pageIndex]);

  const overlaysForPage = useMemo(
    () => (currentPage ? overlayFields.filter((field) => field.box && field.page === currentPage.page) : []),
    [overlayFields, currentPage],
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-xl)] border bg-card p-4",
        fill ? "min-h-0" : "self-start",
        className,
      )}
    >
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

      <div
        className={cn(
          "overflow-auto rounded-[var(--radius-lg)] border bg-muted/30",
          fill ? "min-h-0 flex-1" : "max-h-[80vh]",
        )}
      >
        {currentPage ? (
          <div className="relative inline-block" style={{ width: `${zoom * 100}%` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pageImageUrl(grantId, currentPage.storageKey)}
              alt={`${grantTitle} ${currentPage.page}페이지`}
              className="pointer-events-none block w-full select-none"
              draggable={false}
            />
            {overlaysForPage.map((field) => {
              if (!field.box) return null;
              const active = field.fieldId === selectedFieldId;
              const tone = OVERLAY_STATE_CLASS[field.state];
              return (
                <button
                  key={field.fieldId}
                  type="button"
                  onClick={() => onSelectField(field.fieldId)}
                  title={field.label}
                  aria-label={field.label}
                  className={cn(
                    "absolute rounded-[3px] transition-colors",
                    active ? tone.active : tone.base,
                  )}
                  style={boxToPercentStyle(field.box)}
                />
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
    </div>
  );
}

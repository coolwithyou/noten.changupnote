"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Minus, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { boxToPercentStyle } from "@/lib/documents/bbox";
import type {
  PreviewField,
  PreviewGrant,
  PreviewPage,
  PreviewSurface,
} from "@/lib/server/documents/documentPreview";
import { FieldInspectorPanel } from "./FieldInspectorPanel";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

const STATUS_LABEL: Record<string, string> = {
  open: "접수중",
  upcoming: "예정",
  closed: "마감",
  unknown: "상태 미확인",
};

function pageImageUrl(grantId: string, key: string): string {
  const encoded = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/web/grants/${encodeURIComponent(grantId)}/page-image/${encoded}`;
}

export function DocumentPreviewView({
  grantId,
  grant,
  surfaces,
  selectedSurfaceId,
  pages,
  fields,
}: {
  grantId: string;
  grant: PreviewGrant;
  surfaces: PreviewSurface[];
  selectedSurfaceId: string | null;
  pages: PreviewPage[];
  fields: PreviewField[];
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const fieldRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const currentPage = pages[pageIndex] ?? null;
  const totalPages = pages.length;

  const selectedField = useMemo(
    () => fields.find((field) => field.id === selectedFieldId) ?? null,
    [fields, selectedFieldId],
  );

  const locatedCount = useMemo(() => fields.filter((field) => field.box).length, [fields]);

  // 현재 페이지에 좌표가 있는 필드만 오버레이한다.
  const overlayFields = useMemo(() => {
    if (!currentPage) return [];
    return fields.filter((field) => field.box && field.page === currentPage.page);
  }, [fields, currentPage]);

  function selectFromOverlay(fieldId: string) {
    setSelectedFieldId(fieldId);
    requestAnimationFrame(() => {
      fieldRefs.current[fieldId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function selectFromList(field: PreviewField) {
    setSelectedFieldId(field.id);
    // 좌표가 있으면 해당 페이지로 이동해 오버레이가 보이도록 한다.
    if (field.box && field.page) {
      const targetIndex = pages.findIndex((page) => page.page === field.page);
      if (targetIndex >= 0) setPageIndex(targetIndex);
    }
  }

  const hasAnyData = surfaces.length > 0 || fields.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{STATUS_LABEL[grant.status] ?? grant.status}</Badge>
          <Badge variant="secondary">문서 미리보기</Badge>
          {grant.agencyOperator ? (
            <span className="text-sm text-muted-foreground">{grant.agencyOperator}</span>
          ) : null}
        </div>
        <h1 className="text-xl font-semibold leading-7 sm:text-2xl">{grant.title}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{fields.length}개 필드</span>
          <span aria-hidden>·</span>
          <span>{locatedCount}개 위치 확인</span>
          <span aria-hidden>·</span>
          <span>{totalPages}페이지</span>
        </div>
      </header>

      {surfaces.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {surfaces.map((surface) => {
            const active = surface.id === selectedSurfaceId;
            return (
              <Link
                key={surface.id}
                href={`/grants/${encodeURIComponent(grantId)}/preview?surface=${encodeURIComponent(surface.id)}`}
                className={cn(
                  buttonVariants({ variant: active ? "default" : "outline", size: "sm" }),
                )}
                aria-current={active ? "true" : undefined}
              >
                <FileText data-icon="inline-start" />
                {surface.title}
                <Badge variant={active ? "secondary" : "outline"} className="ml-1">
                  {surface.pageCount}p
                </Badge>
              </Link>
            );
          })}
        </div>
      ) : null}

      {!hasAnyData ? (
        <Empty className="min-h-80 rounded-[var(--radius-xl)] border">
          <EmptyMedia variant="icon">
            <FileText />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>아직 미리볼 문서가 없습니다.</EmptyTitle>
            <EmptyDescription>
              지원사업 양식 변환이 끝나면 페이지 이미지와 작성 항목이 여기에 표시됩니다.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
          {/* 문서 이미지 + 오버레이 */}
          <section className="flex flex-col gap-3 self-start rounded-[var(--radius-xl)] border bg-card p-4">
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

            <div className="max-h-[80vh] overflow-auto rounded-[var(--radius-lg)] border bg-muted/30">
              {currentPage ? (
                <div className="relative inline-block" style={{ width: `${zoom * 100}%` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={pageImageUrl(grantId, currentPage.storageKey)}
                    alt={`${grant.title} ${currentPage.page}페이지`}
                    className="pointer-events-none block w-full select-none"
                    draggable={false}
                  />
                  {overlayFields.map((field) => {
                    if (!field.box) return null;
                    const active = field.id === selectedFieldId;
                    return (
                      <button
                        key={field.id}
                        type="button"
                        onClick={() => selectFromOverlay(field.id)}
                        title={field.label || field.fieldKey}
                        aria-label={field.label || field.fieldKey}
                        className={cn(
                          "absolute rounded-[3px] border transition-colors",
                          active
                            ? "border-2 border-primary bg-primary/25"
                            : "border-primary/60 bg-primary/10 hover:bg-primary/20",
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
                    <EmptyDescription>
                      아래 작성 항목 목록은 그대로 확인할 수 있습니다.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </section>

          {/* 필드 목록 + 인스펙터 */}
          <section className="flex flex-col gap-4 self-start">
            <div className="rounded-[var(--radius-xl)] border bg-card p-4">
              <FieldInspectorPanel field={selectedField} />
            </div>

            <div className="flex flex-col rounded-[var(--radius-xl)] border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold">작성 항목 {fields.length}</h2>
                <span className="text-xs text-muted-foreground">클릭하면 위치가 표시됩니다</span>
              </div>
              {fields.length === 0 ? (
                <Empty className="min-h-40 border-0">
                  <EmptyHeader>
                    <EmptyTitle>표시할 작성 항목이 없습니다.</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="max-h-[60vh] divide-y overflow-auto">
                  {fields.map((field) => {
                    const active = field.id === selectedFieldId;
                    return (
                      <li key={field.id}>
                        <button
                          type="button"
                          ref={(element) => {
                            fieldRefs.current[field.id] = element;
                          }}
                          onClick={() => selectFromList(field)}
                          className={cn(
                            "flex w-full flex-col gap-1 px-4 py-3 text-left text-sm transition-colors",
                            active ? "bg-accent" : "hover:bg-muted/50",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium">
                              {field.label || field.fieldKey}
                            </span>
                            {field.required ? (
                              <Badge variant="default" className="shrink-0">
                                필수
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            {field.section ? <span className="truncate">{field.section}</span> : null}
                            {field.box && field.page ? (
                              <Badge variant="outline" className="h-5">
                                p{field.page}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="h-5 text-muted-foreground">
                                위치 미확인
                              </Badge>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {locatedCount === 0 && fields.length > 0 ? (
              <Alert>
                <AlertTitle>위치 정보는 준비 중입니다</AlertTitle>
                <AlertDescription>
                  작성 항목의 문서 내 위치는 순차적으로 확인되고 있습니다. 지금은 항목 목록과 상세만 제공됩니다.
                </AlertDescription>
              </Alert>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

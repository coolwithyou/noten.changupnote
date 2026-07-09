"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import type {
  PreviewField,
  PreviewGrant,
  PreviewPage,
  PreviewSurface,
} from "@/lib/server/documents/documentPreview";
import { PreviewCanvas, type PreviewOverlayField } from "./PreviewCanvas";
import { FieldInspectorPanel } from "./FieldInspectorPanel";

const STATUS_LABEL: Record<string, string> = {
  open: "접수중",
  upcoming: "예정",
  closed: "마감",
  unknown: "상태 미확인",
};

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
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const fieldRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const selectedField = useMemo(
    () => fields.find((field) => field.id === selectedFieldId) ?? null,
    [fields, selectedFieldId],
  );

  const locatedCount = useMemo(() => fields.filter((field) => field.box).length, [fields]);
  const totalPages = pages.length;

  // 프리뷰 뷰어는 단색 오버레이만 필요하므로 모든 필드에 plain 상태를 준다(시각 회귀 없음).
  const overlayFields = useMemo<PreviewOverlayField[]>(
    () =>
      fields.map((field) => ({
        fieldId: field.id,
        label: field.label || field.fieldKey,
        page: field.page,
        box: field.box,
        state: "plain",
      })),
    [fields],
  );

  // 오버레이 클릭 → 선택 + 리스트 항목으로 스크롤(캔버스의 페이지 이동은 PreviewCanvas 가 담당).
  function handleOverlaySelect(fieldId: string) {
    setSelectedFieldId(fieldId);
    requestAnimationFrame(() => {
      fieldRefs.current[fieldId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
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
                className={cn(buttonVariants({ variant: active ? "default" : "outline", size: "sm" }))}
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
          {/* 문서 이미지 + 오버레이 (PreviewCanvas 재사용) */}
          <PreviewCanvas
            grantId={grantId}
            grantTitle={grant.title}
            pages={pages}
            overlayFields={overlayFields}
            selectedFieldId={selectedFieldId}
            onSelectField={handleOverlaySelect}
          />

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
                          onClick={() => setSelectedFieldId(field.id)}
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

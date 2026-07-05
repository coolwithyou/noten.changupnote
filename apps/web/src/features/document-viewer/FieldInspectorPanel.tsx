"use client";

import { useState } from "react";
import { Check, Copy, MapPin, MapPinOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import type { PreviewField } from "@/lib/server/documents/documentPreview";

const FILL_STRATEGY_LABEL: Record<string, string> = {
  copy: "프로필에서 복사",
  summarize: "요약 생성",
  generate: "초안 생성",
  ask_user: "질문 필요",
  manual: "직접 작성",
};

const FIELD_TYPE_LABEL: Record<string, string> = {
  text: "한 줄 텍스트",
  long_text: "여러 줄 텍스트",
  number: "숫자",
  date: "날짜",
  currency: "금액",
  checkbox: "선택",
  table: "표",
  file: "첨부",
  signature: "서명",
  stamp: "직인",
  unknown: "미확인",
};

function labelOf(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

/**
 * 선택 필드의 상세(Field Inspector, 기능 9.4). label·section·documentName·fieldType·
 * required·fillStrategy·confidence·sourceSpan 을 보여주고 원문 span 을 복사한다.
 * 좌표가 없는 필드는 "위치 미확인" 뱃지 (P4 이전 대부분 이 상태 — 정상).
 */
export function FieldInspectorPanel({ field }: { field: PreviewField | null }) {
  const [copied, setCopied] = useState(false);

  if (!field) {
    return (
      <Empty className="min-h-64 border-0">
        <EmptyMedia variant="icon">
          <MapPin />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>필드를 선택하세요</EmptyTitle>
          <EmptyDescription>
            문서 위 표시된 칸이나 오른쪽 목록에서 항목을 클릭하면 상세가 여기에 표시됩니다.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  async function copySpan(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const confidencePct = Math.round((field.confidence ?? 0) * 100);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {field.required ? <Badge variant="default">필수</Badge> : <Badge variant="outline">선택</Badge>}
          <Badge variant="secondary">{labelOf(FIELD_TYPE_LABEL, field.fieldType)}</Badge>
          {field.box ? (
            <Badge variant="outline" className="gap-1">
              <MapPin className="size-3" />
              위치 확인됨{field.page ? ` · p${field.page}` : ""}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <MapPinOff className="size-3" />
              위치 미확인
            </Badge>
          )}
        </div>
        <h3 className="text-base font-semibold leading-6">{field.label || field.fieldKey}</h3>
        {field.section ? (
          <p className="text-sm text-muted-foreground">{field.section}</p>
        ) : null}
      </div>

      <Separator />

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <DetailRow term="문서">{field.documentName}</DetailRow>
        <DetailRow term="필드 key">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{field.fieldKey}</code>
        </DetailRow>
        <DetailRow term="작성 방식">{labelOf(FILL_STRATEGY_LABEL, field.fillStrategy)}</DetailRow>
        {field.mappedCompanyField ? (
          <DetailRow term="연결 프로필">{field.mappedCompanyField}</DetailRow>
        ) : null}
        <DetailRow term="신뢰도">
          <span className="tabular-nums">{confidencePct}%</span>
        </DetailRow>
      </dl>

      {field.sourceSpan ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">원문</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => copySpan(field.sourceSpan ?? "")}
              className="h-7"
            >
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              {copied ? "복사됨" : "복사"}
            </Button>
          </div>
          <p
            className={cn(
              "max-h-40 overflow-auto rounded-[var(--radius-lg)] border bg-muted/40 p-3 text-sm",
              "whitespace-pre-wrap break-words",
            )}
          >
            {field.sourceSpan}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

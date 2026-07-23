"use client";

import { Check, Clock3, FilePenLine, SkipForward } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { DocumentAuthoringTask, StudioTaskStatus } from "./documentAuthoring";

export function StudioTaskCard({
  task,
  status,
  serverSaved,
  reviewPosition,
  reviewTotal,
  onOpenStudio,
  onConfirm,
  onNotApplicable,
  onLater,
}: {
  task: DocumentAuthoringTask;
  status: StudioTaskStatus;
  serverSaved: boolean;
  reviewPosition: number;
  reviewTotal: number;
  onOpenStudio: () => void;
  onConfirm: () => void;
  onNotApplicable: () => void;
  onLater: () => void;
}) {
  const edited = status === "edited";
  return (
    <Card className="border-studio/35 shadow-[var(--shadow-subtle)]">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge variant="outline" className="border-studio/35 bg-studio-soft text-studio">
            <FilePenLine data-icon="inline-start" aria-hidden />
            문서에서 작성
          </Badge>
          <span className="text-xs tabular-nums text-muted-foreground">
            직접 작성 항목 {reviewTotal.toLocaleString("ko-KR")}개 중 {reviewPosition.toLocaleString("ko-KR")}번째
          </span>
        </div>
        <div className="grid gap-1.5">
          <CardTitle className="text-xl">{task.label}</CardTitle>
          <CardDescription>{task.reason}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {edited ? (
          <div className="rounded-[var(--radius-lg)] border border-success/25 bg-success-soft px-3 py-2.5 text-sm">
            <p className="font-medium text-success">
              {serverSaved
                ? "Studio 편집본이 서버에 저장됐어요."
                : "Studio 편집본이 이 브라우저 탭에 임시 저장됐어요."}
            </p>
            <p className="mt-0.5 text-muted-foreground">내용을 검토했다면 확인 완료로 바꿔 주세요.</p>
          </div>
        ) : (
          <p className="rounded-[var(--radius-lg)] bg-studio-soft px-3 py-2.5 text-sm text-muted-foreground">
            반복 행과 셀 배치를 유지해야 하므로 별도 입력칸으로 축약하지 않고 원본 문서에서 편집합니다.
          </p>
        )}
        {edited ? (
          <Button type="button" onClick={onConfirm} className="w-full">
            <Check data-icon="inline-start" aria-hidden />
            편집 내용 확인 완료
          </Button>
        ) : null}
        <Button type="button" variant={edited ? "outline" : "default"} onClick={onOpenStudio} className="w-full">
          <FilePenLine data-icon="inline-start" aria-hidden />
          {edited ? "문서에서 다시 편집" : "문서에서 편집"}
        </Button>
      </CardContent>
      <CardFooter className="flex-wrap justify-center gap-1 border-t bg-card">
        <Button type="button" variant="ghost" size="sm" onClick={onNotApplicable}>
          <SkipForward data-icon="inline-start" aria-hidden />
          해당 없음
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onLater}>
          <Clock3 data-icon="inline-start" aria-hidden />
          나중에
        </Button>
      </CardFooter>
    </Card>
  );
}

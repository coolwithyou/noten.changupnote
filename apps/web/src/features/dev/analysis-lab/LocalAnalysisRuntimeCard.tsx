"use client";

import { AlertTriangle, ChevronDown, Laptop, LockKeyhole, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import type { LocalAnalysisRuntimeAccess } from "./useLocalAnalysisRuntime";
import { AnalysisLabErrorAlert } from "./AnalysisLabErrorAlert";

export function LocalAnalysisRuntimeCard({ runtime }: { runtime: LocalAnalysisRuntimeAccess }) {
  const productionOn = runtime.status?.effectiveMode === "production_api";
  const anotherOwner = runtime.status?.effectiveMode === "local_subscription"
    && runtime.status.localOwnerId !== runtime.ownerId;
  const statusLabel = runtime.allowed
    ? "남은 lease 해제 필요"
    : productionOn
      ? "운영 자동화 ON"
      : anotherOwner
        ? "다른 세션 사용 중"
        : "관찰 전용";

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Laptop /> 분석 모드
          <Badge
            variant={runtime.allowed ? "default" : productionOn ? "destructive" : "secondary"}
            className="ms-auto"
          >
            {statusLabel}
          </Badge>
        </CardTitle>
        <CardDescription>
          Gate R 동안 이 화면은 관찰 전용입니다. 신규 실행은 승인된 exact Adapter만 소유합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {runtime.allowed ? (
          <Button variant="outline" size="sm" onClick={() => void runtime.release()} disabled={runtime.busy}>
            <LockKeyhole data-icon="inline-start" />
            남은 local lease 해제
          </Button>
        ) : (
          <Button
            size="sm"
            disabled
          >
            <LockKeyhole data-icon="inline-start" />
            Gate R 실행 차단
          </Button>
        )}

        {!runtime.allowed ? (
          <Alert>
            <AlertTitle>live start 비활성</AlertTitle>
            <AlertDescription>
              UI 단건·배치·자동 선정과 legacy 검수 모델 호출은 권한을 얻을 수 없습니다.
            </AlertDescription>
          </Alert>
        ) : null}

        {productionOn ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>운영 자동화가 켜져 있습니다</AlertTitle>
            <AlertDescription>ops `/pipeline`에서 자동화를 끈 뒤 다시 시도하세요.</AlertDescription>
          </Alert>
        ) : null}
        {runtime.error ? (
          <AnalysisLabErrorAlert title="권한 상태를 확인하지 못했습니다" message={runtime.error} />
        ) : null}

        <Collapsible>
          <Separator />
          <CollapsibleTrigger
            render={<Button variant="ghost" size="sm" className="mt-2 w-full justify-between" />}
          >
            실행 환경 상세
            <ChevronDown data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 pt-2 text-xs text-muted-foreground">
            <div className="flex justify-between gap-3">
              <span>모드</span>
              <span className="truncate font-medium text-foreground">{runtime.status?.effectiveMode ?? "확인 중"}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>임대 만료</span>
              <span className="font-medium text-foreground">{formatDateTime(runtime.status?.localLeaseExpiresAt ?? null)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>세션</span>
              <span className="font-mono text-foreground">{runtime.ownerId ? `${runtime.ownerId.slice(0, 8)}…` : "준비 중"}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void runtime.refresh()} disabled={runtime.busy}>
              <RefreshCw data-icon="inline-start" /> 새로고침
            </Button>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(date);
}

"use client";

import { AlertTriangle, Laptop, LockKeyhole, RefreshCw, UnlockKeyhole } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LocalAnalysisRuntimeAccess } from "./useLocalAnalysisRuntime";

export function LocalAnalysisRuntimeCard({ runtime }: { runtime: LocalAnalysisRuntimeAccess }) {
  const productionOn = runtime.status?.effectiveMode === "production_api";
  const anotherOwner = runtime.status?.effectiveMode === "local_subscription"
    && runtime.status.localOwnerId !== runtime.ownerId;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Laptop className="size-4" /> 로컬 구독 분석 권한
          {runtime.allowed ? (
            <Badge>사용 가능</Badge>
          ) : productionOn ? (
            <Badge variant="destructive">운영 자동화 ON</Badge>
          ) : anotherOwner ? (
            <Badge variant="secondary">다른 로컬 세션 사용 중</Badge>
          ) : (
            <Badge variant="outline">잠김</Badge>
          )}
        </CardTitle>
        <CardDescription>
          로컬 분석은 Claude 구독 사용량을 쓰며 API 종량제 과금은 하지 않습니다. 권한이 있는 동안 운영 API 자동화는 켤 수 없습니다.
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void runtime.refresh()} disabled={runtime.busy}>
            <RefreshCw /> 새로고침
          </Button>
          {runtime.allowed ? (
            <Button variant="outline" size="sm" onClick={() => void runtime.release()} disabled={runtime.busy}>
              <LockKeyhole /> 권한 해제
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void runtime.acquire()}
              disabled={runtime.busy || productionOn || anotherOwner || !runtime.ownerId}
            >
              <UnlockKeyhole /> 로컬 분석 권한 획득
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>모드 {runtime.status?.effectiveMode ?? "불러오는 중"}</span>
          <span>generation {runtime.status?.generation ?? "—"}</span>
          <span>임대 만료 {formatDateTime(runtime.status?.localLeaseExpiresAt ?? null)}</span>
          <span>세션 {runtime.ownerId ? `${runtime.ownerId.slice(0, 8)}…` : "준비 중"}</span>
        </div>
        {productionOn ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>운영 API 자동화가 켜져 있습니다</AlertTitle>
            <AlertDescription>ops `/pipeline`에서 운영 자동화를 끈 뒤 로컬 권한을 획득하세요.</AlertDescription>
          </Alert>
        ) : null}
        {runtime.error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>로컬 분석 권한 오류</AlertTitle>
            <AlertDescription>{runtime.error}</AlertDescription>
          </Alert>
        ) : null}
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

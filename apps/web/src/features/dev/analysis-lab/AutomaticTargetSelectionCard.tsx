"use client";

import { useState } from "react";
import { CheckCircle2, LoaderCircle, Sparkles } from "lucide-react";
import type { LabAutomaticTargetSelectionResult } from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { localAnalysisRequestHeaders } from "./useLocalAnalysisRuntime";

const TARGETS_URL = "/api/dev/analysis-lab/ops/targets";
const PILOT_TARGET_COUNT = 30;

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `자동 선정에 실패했습니다. (HTTP ${response.status})`;
  } catch {
    return `자동 선정에 실패했습니다. (HTTP ${response.status})`;
  }
}

export function AutomaticTargetSelectionCard({
  analysisAllowed,
  analysisOwnerId,
  pendingCount,
  batchRunning,
  onSelected,
}: {
  analysisAllowed: boolean;
  analysisOwnerId: string | null;
  pendingCount: number | null;
  batchRunning: boolean;
  onSelected: (result: LabAutomaticTargetSelectionResult) => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [result, setResult] = useState<LabAutomaticTargetSelectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blockedReason = !analysisAllowed
    ? "먼저 왼쪽에서 구독 분석 모드를 켜세요."
    : pendingCount === null
      ? "현재 분석 대기 수를 확인하고 있습니다."
    : batchRunning
      ? "현재 분석 배치가 끝난 뒤 새 대상을 고를 수 있습니다."
      : pendingCount > 0
        ? `현재 대기 ${pendingCount}건을 먼저 분석하세요.`
        : null;

  const selectTargets = async () => {
    setSelecting(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(TARGETS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...localAnalysisRequestHeaders(analysisOwnerId),
        },
        body: JSON.stringify({ count: PILOT_TARGET_COUNT }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const selected = (await response.json()) as LabAutomaticTargetSelectionResult;
      setResult(selected);
      onSelected(selected);
    } catch {
      setError("네트워크 오류로 분석 대상을 자동 선정하지 못했습니다.");
    } finally {
      setSelecting(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sparkles /> 새 분석 대상 고르기</CardTitle>
        <CardDescription>
          모집 중인 미분석 공고를 먼저 안전하게 거른 뒤 Claude가 대표성 있는 30건을 고릅니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge>구독 모델</Badge>
          <Badge variant="outline">추가 API 비용 없음</Badge>
          <Badge variant="outline">HWP/HWPX 준비 완료만</Badge>
        </div>
        <Button
          className="w-full"
          disabled={selecting || blockedReason !== null}
          onClick={() => void selectTargets()}
        >
          {selecting ? (
            <><LoaderCircle className="animate-spin" data-icon="inline-start" /> Claude가 30건을 고르는 중…</>
          ) : (
            <><Sparkles data-icon="inline-start" /> 새 공고 30건 자동 선정</>
          )}
        </Button>
        {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>자동 선정 실패</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
        {result ? (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>새 분석 대상 {result.selected.length}건을 추가했습니다</AlertTitle>
            <AlertDescription>
              안전 후보 {result.eligibleCandidateCount}건 중 Claude가 선정했습니다. 이제 분석 대기
              {" "}{result.selected.length}건을 일괄 실행할 수 있습니다.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

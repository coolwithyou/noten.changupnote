"use client";

import { useEffect, useState } from "react";
import { ChevronDown, FileCheck2, OctagonX, Play, SearchCheck, Settings2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { LabBatchJobSnapshot, LabBatchStartRequest, LabOpsSummary } from "./contract";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// ─────────────────────────────────────────────────────────────────────────────
// 실행 콘솔 — 배치 시작 옵션(LabBatchStartRequest)을 구성해 POST 하고, 실행 중이면 중단한다.
// transport 기본값은 서버 해석(transportStatus.resolved) — 여기서의 명시 선택이 env 보다 우선.
// 검증 실패의 최종 판정은 서버 소관이며 아래 상수·검증은 UI 선제 안내다.
// ─────────────────────────────────────────────────────────────────────────────

/** batch CLI 와 동일한 기본값·상한(batch.ts DEFAULT_* / MAX_CONCURRENCY — export 없어 표시용 복제). */
const DEFAULT_LIMIT = "30";
const DEFAULT_CONCURRENCY = "2";
// 로컬 구독 배치는 실제 API 과금이 없지만 러너가 모델 사용량을 명목 USD로 환산해
// 폭주 가드를 적용한다. 모집 중 전건 분석에서도 이 비교값 때문에 조기 중단되지 않도록
// 충분히 큰 기본값을 쓰되, API transport는 서버가 별도로 금지한다.
const DEFAULT_MAX_COST_USD = "1000";
const MAX_CONCURRENCY = 3;

export function BatchOpsConsole({
  analysisAllowed,
  summary,
  snapshot,
  starting,
  stopping,
  onStart,
  onStop,
}: {
  analysisAllowed: boolean;
  summary: LabOpsSummary | null;
  snapshot: LabBatchJobSnapshot | null;
  starting: boolean;
  stopping: boolean;
  onStart: (request: LabBatchStartRequest) => void;
  onStop: () => void;
}) {
  // 사용자가 건드리기 전에는 서버 해석(resolved)을 따라간다 — summary 로드 전 기본은 api.
  const [model, setModel] = useState("");
  const [limitText, setLimitText] = useState(DEFAULT_LIMIT);
  const [concurrencyText, setConcurrencyText] = useState(DEFAULT_CONCURRENCY);
  const [maxCostText, setMaxCostText] = useState(DEFAULT_MAX_COST_USD);
  const [retryErrors, setRetryErrors] = useState(false);
  const [reanalyzeOutdated, setReanalyzeOutdated] = useState(false);
  const [limitEdited, setLimitEdited] = useState(false);

  const transport = "claude-cli" as const;

  const limit = Number(limitText);
  const concurrency = Number(concurrencyText);
  const maxCostUsd = Number(maxCostText);
  const limitValid = Number.isInteger(limit) && limit >= 1;
  const concurrencyValid =
    Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_CONCURRENCY;
  const maxCostValid = Number.isFinite(maxCostUsd) && maxCostUsd > 0;
  const formValid = limitValid && concurrencyValid && maxCostValid;

  const running = snapshot?.state === "running";
  const pendingCount = summary?.funnel.analysisPending ?? null;
  const hasDefaultTargets = pendingCount === null || pendingCount > 0;
  const showRunForm = running || hasDefaultTargets || retryErrors || reanalyzeOutdated;

  useEffect(() => {
    if (limitEdited || pendingCount === null || pendingCount <= 0) return;
    setLimitText(String(Math.min(Number(DEFAULT_LIMIT), pendingCount)));
  }, [limitEdited, pendingCount]);

  const handleStart = () => {
    if (!formValid || running || starting) return;
    const trimmedModel = model.trim();
    onStart({
      limit,
      concurrency,
      maxCostUsd,
      retryErrors,
      reanalyzeOutdated,
      transport,
      withApplicationRoundtrip: true,
      ...(trimmedModel ? { model: trimmedModel } : {}),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>새 배치 시작</CardTitle>
        <CardDescription>
          한 번의 실행으로 같은 공고의 두 분석을 함께 준비합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-3">
            <SearchCheck className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">22축 공고 딥분석</p>
              <p className="text-xs text-muted-foreground">자격·제외·우대·평가 조건</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-3">
            <FileCheck2 className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">지원서 빠른 작성 분석</p>
              <p className="text-xs text-muted-foreground">HWP/HWPX 필드·선택지 인식</p>
            </div>
          </div>
        </div>

        {!analysisAllowed ? (
          <Alert>
            <AlertTitle>먼저 구독 분석 모드를 켜세요</AlertTitle>
            <AlertDescription>왼쪽 분석 모드에서 버튼을 누르면 이 PC에서만 실행 권한이 열립니다.</AlertDescription>
          </Alert>
        ) : null}

        {!showRunForm ? (
          <Alert>
            <AlertTitle>새로 분석할 공고가 없습니다</AlertTitle>
            <AlertDescription>
              현행 기준의 대기열은 모두 처리됐습니다. 오류나 구버전 결과를 다시 처리하려면 아래 고급 실행 설정을 여세요.
            </AlertDescription>
          </Alert>
        ) : (
          <FieldGroup>
            <Field data-invalid={!limitValid || undefined}>
              <FieldLabel htmlFor="batch-ops-limit">이번에 처리할 공고 수</FieldLabel>
              <Input
                id="batch-ops-limit"
                inputMode="numeric"
                value={limitText}
                onChange={(event) => {
                  setLimitEdited(true);
                  setLimitText(event.target.value);
                }}
                aria-invalid={!limitValid || undefined}
                disabled={running}
              />
              <FieldDescription>
                현재 대기 {summary ? `${summary.funnel.analysisPending}건` : "—"} 중 최대 처리 수입니다.
              </FieldDescription>
            </Field>
          </FieldGroup>
        )}

        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="w-full justify-between" />}>
            <span className="flex items-center gap-2"><Settings2 /> 고급 실행 설정</span>
            <ChevronDown data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-4">
            <FieldGroup>
              <Field>
                <FieldLabel>호출 방식</FieldLabel>
                <ToggleGroup variant="outline" size="sm" spacing={1} value={[transport]} disabled aria-label="추론 방식 선택">
                  <ToggleGroupItem value="claude-cli">구독 (claude CLI)</ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription>로컬 실행에서는 API transport를 사용할 수 없습니다.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="batch-ops-model">모델</FieldLabel>
                <Input
                  id="batch-ops-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={summary?.transportStatus.model ?? "서버 env 모델"}
                  disabled={running}
                />
                <FieldDescription>비워 두면 현재 로컬 모델을 사용합니다.</FieldDescription>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <Field data-invalid={!concurrencyValid || undefined}>
                  <FieldLabel htmlFor="batch-ops-concurrency">동시 처리 수</FieldLabel>
                  <Input
                    id="batch-ops-concurrency"
                    inputMode="numeric"
                    value={concurrencyText}
                    onChange={(event) => setConcurrencyText(event.target.value)}
                    aria-invalid={!concurrencyValid || undefined}
                    disabled={running}
                  />
                  <FieldDescription>안전 범위 1~{MAX_CONCURRENCY}</FieldDescription>
                </Field>
                <Field data-invalid={!maxCostValid || undefined}>
                  <FieldLabel htmlFor="batch-ops-max-cost">명목 비용 가드</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon><InputGroupText>$</InputGroupText></InputGroupAddon>
                    <InputGroupInput
                      id="batch-ops-max-cost"
                      inputMode="decimal"
                      value={maxCostText}
                      onChange={(event) => setMaxCostText(event.target.value)}
                      aria-invalid={!maxCostValid || undefined}
                      disabled={running}
                    />
                  </InputGroup>
                  <FieldDescription>실제 과금이 아닌 폭주 감지용 비교값 · 기본 $1,000</FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel>다시 포함할 공고</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  <Toggle variant="outline" size="sm" pressed={retryErrors} onPressedChange={setRetryErrors} disabled={running}>
                    오류 런 재시도
                  </Toggle>
                  <Toggle variant="outline" size="sm" pressed={reanalyzeOutdated} onPressedChange={setReanalyzeOutdated} disabled={running}>
                    구버전 재분석
                  </Toggle>
                </div>
              </Field>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <Badge variant="outline">실제 API 비용 $0</Badge>
          <span>완료 결과는 로컬 파일에 보존됩니다.</span>
        </div>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 sm:flex-row">
        {running ? (
          <Button variant="outline" onClick={onStop} disabled={stopping} className="w-full">
            {stopping ? <Spinner data-icon="inline-start" /> : <OctagonX data-icon="inline-start" />}
            현재 배치 중단
          </Button>
        ) : showRunForm ? (
          <Button onClick={handleStart} disabled={!analysisAllowed || starting || !formValid} className="w-full">
            {starting ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
            {limitValid ? `${limit}건 분석 시작` : "배치 시작"}
          </Button>
        ) : null}
        {showRunForm && !formValid ? <span className="text-xs text-destructive">입력값을 확인해 주세요.</span> : null}
      </CardFooter>
    </Card>
  );
}

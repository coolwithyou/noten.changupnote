"use client";

import { useState } from "react";
import { OctagonX, Play } from "lucide-react";
import type { LabBatchJobSnapshot, LabBatchStartRequest, LabOpsSummary } from "./contract";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
const DEFAULT_LIMIT = "10";
const DEFAULT_CONCURRENCY = "2";
const DEFAULT_MAX_COST_USD = "5";
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
        <CardTitle>실행 콘솔</CardTitle>
        <CardDescription>
          구독(claude CLI)으로 22축 딥분석과 Kordoc 지원서 선분석을 함께 시작합니다 — 동시 1잡(웹 기준).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel>transport</FieldLabel>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={1}
              value={[transport]}
              disabled
              aria-label="추론 transport 선택"
            >
              <ToggleGroupItem value="claude-cli">구독 (claude CLI)</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              로컬 실행은 구독 transport로 고정됩니다. 서버도 API transport를 거부합니다.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="batch-ops-model">model</FieldLabel>
            <Input
              id="batch-ops-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={summary?.transportStatus.model ?? "서버 env 모델"}
              disabled={running}
            />
            <FieldDescription>비워 두면 서버 env 모델을 그대로 사용합니다.</FieldDescription>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field data-invalid={!limitValid || undefined}>
              <FieldLabel htmlFor="batch-ops-limit">limit</FieldLabel>
              <Input
                id="batch-ops-limit"
                inputMode="numeric"
                value={limitText}
                onChange={(event) => setLimitText(event.target.value)}
                aria-invalid={!limitValid || undefined}
                disabled={running}
              />
              <FieldDescription>이번 배치 최대 분석 건수 — 1 이상 정수.</FieldDescription>
            </Field>
            <Field data-invalid={!concurrencyValid || undefined}>
              <FieldLabel htmlFor="batch-ops-concurrency">concurrency</FieldLabel>
              <Input
                id="batch-ops-concurrency"
                inputMode="numeric"
                value={concurrencyText}
                onChange={(event) => setConcurrencyText(event.target.value)}
                aria-invalid={!concurrencyValid || undefined}
                disabled={running}
              />
              <FieldDescription>워커 수 — 1~{MAX_CONCURRENCY}.</FieldDescription>
            </Field>
            <Field data-invalid={!maxCostValid || undefined}>
              <FieldLabel htmlFor="batch-ops-max-cost">max cost (명목 USD)</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>$</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="batch-ops-max-cost"
                  inputMode="decimal"
                  value={maxCostText}
                  onChange={(event) => setMaxCostText(event.target.value)}
                  aria-invalid={!maxCostValid || undefined}
                  disabled={running}
                />
              </InputGroup>
              <FieldDescription>누적 명목 비용 상한 — 도달 시 신규 착수 중단.</FieldDescription>
            </Field>
          </div>

          <Field>
            <FieldLabel>재실행 옵션</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              <Toggle
                variant="outline"
                size="sm"
                pressed={retryErrors}
                onPressedChange={setRetryErrors}
                disabled={running}
              >
                error 런 재시도
              </Toggle>
              <Toggle
                variant="outline"
                size="sm"
                pressed={reanalyzeOutdated}
                onPressedChange={setReanalyzeOutdated}
                disabled={running}
              >
                구버전 재분석
              </Toggle>
            </div>
            <FieldDescription>
              보류(error)·구버전 공고를 이번 배치 대상에 다시 포함합니다.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <p className="tabular-nums">
            실행 대상 후보 {summary ? `${summary.funnel.analysisPending}건` : "—"}(깔때기 ④ 잔여
            기준) — 실제 대상 수·예상 명목 비용은 시작 직후 plan 이벤트로 갱신됩니다.
          </p>
          <p>
            dev 서버 재시작 시 진행 중 잡은 소멸합니다 — 완료된 런은 저장되며, 재실행이 곧
            재개입니다.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleStart} disabled={!analysisAllowed || running || starting || !formValid}>
            {starting ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
            배치 시작
          </Button>
          <Button variant="outline" onClick={onStop} disabled={!running || stopping}>
            {stopping ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <OctagonX data-icon="inline-start" />
            )}
            중단
          </Button>
          {running ? (
            <span className="text-xs text-muted-foreground">
              배치 실행 중 — 완료·중단 후 다시 시작할 수 있습니다.
            </span>
          ) : !analysisAllowed ? (
            <span className="text-xs text-destructive">
              위에서 로컬 구독 분석 권한을 먼저 획득해 주세요.
            </span>
          ) : !formValid ? (
            <span className="text-xs text-destructive">
              입력값을 확인해 주세요 — limit 1 이상 정수 · concurrency 1~{MAX_CONCURRENCY} · 상한
              0 초과.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

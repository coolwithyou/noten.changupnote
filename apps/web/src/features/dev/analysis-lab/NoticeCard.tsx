"use client";

import { useState } from "react";
import { CalendarClock, ClipboardCheck } from "lucide-react";
import type { LabNoticeSummary, LabRunSummary } from "./contract";
import { classifyNoticePeriod } from "./notice-period";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  auditBadgeMeta,
  formatBytes,
  formatDate,
  formatDateTime,
  noticeAuditStatus,
  sourceLabel,
} from "./labels";

// 코호트 공고 1건 카드 — 첨부 확보 상태·현재 criteria 수·런 목록·검수 상태를 보여주고
// Opus 딥분석 실행·런 선택·원클릭 검수의 진입점이 된다.

/** 런 셀렉트 라벨의 감사 상태 접미(§9) — 감사 대상 런에만 붙는다. */
function runAuditSuffix(run: LabRunSummary): string {
  return run.auditStatus ? ` · ${auditBadgeMeta(run.auditStatus).label}` : "";
}
export function NoticeCard({
  notice,
  analyzing,
  elapsedSec,
  analyzeDisabled,
  analyzeError,
  analyzeNotice,
  selectedRunId,
  onAnalyze,
  onSelectRun,
  onReview,
  onPeriodSaved,
}: {
  notice: LabNoticeSummary;
  /** 이 공고의 분석이 실행 중인지. */
  analyzing: boolean;
  /** 실행 중 경과 시간(초). */
  elapsedSec: number;
  /** 다른 공고 분석 중 등으로 실행 버튼을 잠글지. */
  analyzeDisabled: boolean;
  analyzeError: string | null;
  /** 분석 완료 시 화면 전환을 보류했을 때의 안내 (미저장 검수 초안 보호). */
  analyzeNotice: string | null;
  selectedRunId: string | null;
  onAnalyze: () => void;
  onSelectRun: (runId: string) => void;
  /** 검수 탭을 바로 연다(검수된 성공 런 우선) — 성공 런이 없으면 카드가 버튼을 숨긴다. */
  onReview: () => void;
  /** 기간 미상 공고의 기간을 저장한 뒤 목록 재로드 — 배지 해제 확인용. */
  onPeriodSaved: () => void;
}) {
  // 런 목록은 startedAt desc — 첫 성공 런이 곧 최신 성공 런이다.
  const latestOkRun = notice.runs.find((run) => run.ok);
  // 검수 완료 판정·버튼 라벨은 성공 런 기준 — openReview 가 여는 대상과 일치시킨다.
  const reviewedOkRun = notice.runs.find((run) => run.ok && run.reviewedAt !== null);
  const reviewed = Boolean(reviewedOkRun);
  // 감사 상태(§9) — 사람 검수 없는 공고에서 AI 검수 감사의 진행을 최소 표시한다.
  const auditStatus = reviewed ? null : noticeAuditStatus(notice);
  const auditBadge = auditStatus ? auditBadgeMeta(auditStatus) : null;
  // 모집기간 정책(2026-07-23) — unknown 이면 분석 차단 + 기간 특정 입력을 노출한다.
  const periodStatus = classifyNoticePeriod(notice.applyStart, notice.applyEnd);
  const periodUnknown = periodStatus === "unknown";

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{sourceLabel(notice.source)}</Badge>
          <Badge variant="outline">{notice.status}</Badge>
          {periodUnknown ? (
            <Badge variant="destructive">기간 미상</Badge>
          ) : periodStatus === "closed" ? (
            <Badge variant="outline">접수 마감</Badge>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground">{notice.sourceId}</span>
          <span className="ms-auto flex items-center gap-1.5">
            {auditBadge ? (
              <Badge variant={auditBadge.variant} className="tabular-nums">
                {auditBadge.label}
              </Badge>
            ) : null}
            <Badge variant={reviewed ? "default" : "outline"}>
              {reviewed ? "검수됨" : "검수 대기"}
            </Badge>
          </span>
        </div>
        <CardTitle className="text-base leading-snug break-words">
          {notice.url ? (
            <a
              href={notice.url}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {notice.title}
            </a>
          ) : (
            notice.title
          )}
        </CardTitle>
        <CardDescription>
          {notice.agency ?? "기관 미상"} · 접수 {formatDate(notice.applyStart)} ~{" "}
          {formatDate(notice.applyEnd)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {/* 기간 미상 예외 큐(모집기간 정책 2026-07-23) — 감사로 기간을 특정하면 분석 대상에 편입된다. */}
        {periodUnknown ? (
          <NoticePeriodForm grantId={notice.grantId} onSaved={onPeriodSaved} />
        ) : null}

        {/* 혜택 배지 — 이 공고에서 받을 수 있는 것(제품 공용 7 family). 미분류도 드러낸다(dev 신호). */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">혜택</span>
          {notice.benefits.length > 0 ? (
            notice.benefits.map((benefit) => (
              <Badge key={benefit.family}>{benefit.label}</Badge>
            ))
          ) : (
            <Badge variant="ghost">미분류</Badge>
          )}
        </div>

        {/* 첨부 상태 — markdown 확보 여부와 크기 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            첨부 {notice.attachments.length}건
          </span>
          {notice.attachments.length === 0 ? (
            <span className="text-xs text-muted-foreground">첨부 없음</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {notice.attachments.map((attachment, index) => (
                <li key={index} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="max-w-full truncate" title={attachment.filename}>
                    {attachment.filename}
                  </span>
                  {attachment.markdownAvailable ? (
                    <Badge variant="secondary">
                      MD {formatBytes(attachment.markdownBytes)}
                    </Badge>
                  ) : (
                    <Badge variant="outline">
                      MD 없음{attachment.conversionStatus ? ` · ${attachment.conversionStatus}` : ""}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="outline" className="tabular-nums">
            현재 criteria {notice.currentCriteriaCount}개
          </Badge>
          <Badge variant="outline" className="tabular-nums">런 {notice.runs.length}개</Badge>
        </div>

        {/* 런 선택 — 선택 시 하단에 상세·검수 패널이 열린다 */}
        {notice.runs.length > 0 ? (
          <Field>
            <FieldLabel htmlFor={`analysis-lab-run-select-${notice.grantId}`}>
              저장된 런
            </FieldLabel>
            <Select
              items={notice.runs.map((run) => ({
                value: run.runId,
                label: `${formatDateTime(run.startedAt)} · ${run.promptVersion}${run.ok ? "" : " · 실패"}${run.reviewedAt ? " · 검수됨" : ""}${runAuditSuffix(run)}`,
              }))}
              value={selectedRunId}
              onValueChange={(value) => {
                if (typeof value === "string") onSelectRun(value);
              }}
            >
              <SelectTrigger
                id={`analysis-lab-run-select-${notice.grantId}`}
                size="sm"
                className="w-full text-sm"
              >
                <SelectValue placeholder="런 선택" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {notice.runs.map((run) => (
                    <SelectItem key={run.runId} value={run.runId}>
                      {formatDateTime(run.startedAt)} · {run.promptVersion}
                      {run.ok ? "" : " · 실패"}
                      {run.reviewedAt ? " · 검수됨" : ""}
                      {runAuditSuffix(run)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              런을 선택하면 페이지 하단에 상세·검수 패널이 열립니다.
            </FieldDescription>
          </Field>
        ) : null}

        {analyzeError ? (
          <Alert variant="destructive">
            <AlertTitle>분석 실패</AlertTitle>
            <AlertDescription className="break-words">{analyzeError}</AlertDescription>
          </Alert>
        ) : null}

        {analyzeNotice ? (
          <Alert>
            <AlertTitle>분석 완료</AlertTitle>
            <AlertDescription className="break-words">{analyzeNotice}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">
        {latestOkRun ? (
          <Button onClick={onReview} disabled={analyzing}>
            <ClipboardCheck data-icon="inline-start" />
            {reviewed ? "검수 이어서 하기" : "최신 런 검수하기"}
          </Button>
        ) : null}
        <Button
          variant={latestOkRun ? "outline" : "default"}
          onClick={onAnalyze}
          disabled={analyzeDisabled || analyzing || periodUnknown}
        >
          {analyzing ? (
            <>
              <Spinner data-icon="inline-start" />
              분석 중… {elapsedSec}초
            </>
          ) : latestOkRun ? (
            "딥분석 다시 실행"
          ) : (
            "Opus 딥분석 실행"
          )}
        </Button>
        {periodUnknown ? (
          <span className="text-center text-[11px] text-muted-foreground">
            기간 미상 공고는 분석 대상이 아닙니다 — 위에서 접수 기간을 먼저 저장하세요.
          </span>
        ) : null}
        {analyzing ? (
          <span className="text-center text-[11px] text-muted-foreground">
            동기 분석 — 1~5분 걸립니다. 창을 닫지 마세요.
          </span>
        ) : null}
      </CardFooter>
    </Card>
  );
}

const NOTICE_PERIOD_URL = "/api/dev/analysis-lab/notice-period";

/**
 * 기간 미상 공고의 기간 특정 입력(모집기간 정책 2026-07-23).
 * 원문 공고를 감사해 접수 기간을 입력하면 PATCH /api/dev/analysis-lab/notice-period 로
 * grants.applyStart/applyEnd 를 갱신하고, 저장 성공 시 onSaved 로 목록을 재로드해
 * "기간 미상" 배지가 해제되는지 확인할 수 있게 한다. 날짜는 KST 캘린더 기준(서버가
 * 저장 규약대로 UTC 자정으로 해석 — notice-period.ts 헤더 참조).
 */
function NoticePeriodForm({ grantId, onSaved }: { grantId: string; onSaved: () => void }) {
  const [applyStart, setApplyStart] = useState("");
  const [applyEnd, setApplyEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    if (!applyEnd) {
      setError("접수 마감일은 필수입니다.");
      return;
    }
    // "YYYY-MM-DD" 는 사전순 == 시간순 — 문자열 비교로 충분하다(서버도 재검증).
    if (applyStart && applyStart > applyEnd) {
      setError("접수 시작일이 마감일보다 늦을 수 없습니다.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(NOTICE_PERIOD_URL, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grantId,
          applyStart: applyStart || null,
          applyEnd,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? `기간 저장에 실패했습니다. (HTTP ${response.status})`);
        return;
      }
      onSaved();
    } catch {
      setError("네트워크 오류로 기간을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <Alert>
        <CalendarClock />
        <AlertTitle>기간 미상 — 감사로 기간 특정 필요</AlertTitle>
        <AlertDescription className="break-words">
          지원 기간(접수 마감일)을 찾지 못해 AI 분석 대상에서 제외된 공고입니다. 원문
          공고에서 접수 기간을 확인해 저장하면 분석 대상에 편입될 수 있습니다.
        </AlertDescription>
      </Alert>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`analysis-lab-period-start-${grantId}`}>접수 시작(선택)</FieldLabel>
          <Input
            id={`analysis-lab-period-start-${grantId}`}
            type="date"
            value={applyStart}
            onChange={(event) => setApplyStart(event.target.value)}
            disabled={saving}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`analysis-lab-period-end-${grantId}`}>접수 마감(필수)</FieldLabel>
          <Input
            id={`analysis-lab-period-end-${grantId}`}
            type="date"
            value={applyEnd}
            onChange={(event) => setApplyEnd(event.target.value)}
            disabled={saving}
          />
        </Field>
      </div>
      <FieldDescription>
        날짜는 한국 시간(KST) 기준으로 저장됩니다 — 마감일 당일까지 분석 대상으로 봅니다.
      </FieldDescription>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>기간 저장 실패</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button size="sm" onClick={() => void save()} disabled={saving || !applyEnd}>
        {saving ? (
          <>
            <Spinner data-icon="inline-start" />
            저장 중…
          </>
        ) : (
          "기간 저장"
        )}
      </Button>
    </div>
  );
}

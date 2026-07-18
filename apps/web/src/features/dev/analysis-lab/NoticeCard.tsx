"use client";

import type { LabNoticeSummary } from "./contract";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes, formatDate, formatDateTime, sourceLabel } from "./labels";

// 코호트 공고 1건 카드 — 첨부 확보 상태·현재 criteria 수·런 목록을 보여주고
// Opus 딥분석 실행과 런 선택의 진입점이 된다.
export function NoticeCard({
  notice,
  analyzing,
  elapsedSec,
  analyzeDisabled,
  analyzeError,
  selectedRunId,
  onAnalyze,
  onSelectRun,
}: {
  notice: LabNoticeSummary;
  /** 이 공고의 분석이 실행 중인지. */
  analyzing: boolean;
  /** 실행 중 경과 시간(초). */
  elapsedSec: number;
  /** 다른 공고 분석 중 등으로 실행 버튼을 잠글지. */
  analyzeDisabled: boolean;
  analyzeError: string | null;
  selectedRunId: string | null;
  onAnalyze: () => void;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{sourceLabel(notice.source)}</Badge>
          <Badge variant="outline">{notice.status}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground">{notice.sourceId}</span>
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

        {/* 런 선택 — 선택 시 상세 패널 로드 */}
        {notice.runs.length > 0 ? (
          <Select
            items={notice.runs.map((run) => ({
              value: run.runId,
              label: `${formatDateTime(run.startedAt)} · ${run.promptVersion}${run.ok ? "" : " · 실패"}${run.reviewedAt ? " · 검수됨" : ""}`,
            }))}
            value={selectedRunId}
            onValueChange={(value) => {
              if (typeof value === "string") onSelectRun(value);
            }}
          >
            <SelectTrigger size="sm" className="w-full text-sm">
              <SelectValue placeholder="런 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {notice.runs.map((run) => (
                  <SelectItem key={run.runId} value={run.runId}>
                    {formatDateTime(run.startedAt)} · {run.promptVersion}
                    {run.ok ? "" : " · 실패"}
                    {run.reviewedAt ? " · 검수됨" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}

        {analyzeError ? (
          <Alert variant="destructive">
            <AlertTitle>분석 실패</AlertTitle>
            <AlertDescription className="break-words">{analyzeError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button className="w-full" onClick={onAnalyze} disabled={analyzeDisabled || analyzing}>
          {analyzing ? (
            <>
              <Spinner data-icon="inline-start" />
              분석 중… {elapsedSec}초
            </>
          ) : (
            "Opus 딥분석 실행"
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

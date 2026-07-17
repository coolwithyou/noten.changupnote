"use client";

import type { LabProgramIntent, LabRun, LabTaxonomyProposal } from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DimensionDiffTable } from "./DimensionDiffTable";
import { MarkdownView } from "./MarkdownView";
import { formatDateTime, formatDuration, formatUsd, sourceLabel } from "./labels";

// 선택된 런의 상세 패널 — ① 분석 문서(마크다운) ② 필드 채움(22축 diff) ③ 실행 메타.
export function RunDetail({ run }: { run: LabRun }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{sourceLabel(run.source)}</Badge>
          <Badge variant="outline">{run.model}</Badge>
          <Badge variant="outline">{run.promptVersion}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground">{run.runId}</span>
        </div>
        <CardTitle className="text-base leading-snug break-words">{run.title}</CardTitle>
        <CardDescription>
          {formatDateTime(run.startedAt)} 시작 · {formatDuration(run.durationMs)} ·{" "}
          {formatUsd(run.costUsd)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {run.error ? (
          <Alert variant="destructive">
            <AlertTitle>런 오류</AlertTitle>
            <AlertDescription className="break-words">{run.error}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs defaultValue="fields">
          <TabsList>
            <TabsTrigger value="document">분석 문서</TabsTrigger>
            <TabsTrigger value="fields">필드 채움</TabsTrigger>
            <TabsTrigger value="meta">실행 메타</TabsTrigger>
          </TabsList>

          <TabsContent value="document" className="pt-4">
            {run.analysisMarkdown.trim().length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                분석 문서가 비어 있습니다.
              </p>
            ) : (
              <MarkdownView markdown={run.analysisMarkdown} />
            )}
          </TabsContent>

          <TabsContent value="fields" className="flex flex-col gap-4 pt-4">
            <ProgramIntentCard intent={run.programIntent} />
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                22축 diff — 현재 DB(A) vs 딥분석 제안(B)
              </span>
              <span className="text-xs text-muted-foreground">
                실제 DB(grant_criteria)가 어떻게 채워지는지 축 단위 블럭으로 비교합니다 — 채워진
                축은 상단에, 미채움 축은 하단 그리드에 구분됩니다. 저장은 수행하지 않습니다.
              </span>
            </div>
            <DimensionDiffTable diffs={run.dimensionDiffs} />
            {run.taxonomyProposals.length > 0 ? (
              <>
                <Separator />
                <TaxonomyProposals proposals={run.taxonomyProposals} />
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="meta" className="pt-4">
            <RunMeta run={run} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** 공모의 정성적 방향성(programIntent) 카드. */
function ProgramIntentCard({ intent }: { intent: LabProgramIntent | null }) {
  if (!intent) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        programIntent 없음 — 이 런에는 정성 요약이 없습니다.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
      <p className="text-sm font-semibold">{intent.oneLiner}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">타겟 프로파일</dt>
          <dd>{intent.targetProfile}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">지원 내용</dt>
          <dd>{intent.benefitSummary}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">심사 포인트</dt>
          <dd>
            {intent.evaluationFocus.length === 0 ? (
              <span className="text-muted-foreground">없음</span>
            ) : (
              <ul className="list-disc pl-4">
                {intent.evaluationFocus.map((focus, index) => (
                  <li key={index}>{focus}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">유의사항</dt>
          <dd>
            {intent.cautionNotes.length === 0 ? (
              <span className="text-muted-foreground">없음</span>
            ) : (
              <ul className="list-disc pl-4">
                {intent.cautionNotes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** 22축에 담기지 않는 반복 요건의 신규 축 제안 목록. */
function TaxonomyProposals({ proposals }: { proposals: LabTaxonomyProposal[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">신규 축 제안 ({proposals.length}건)</span>
      <span className="text-xs text-muted-foreground">
        수집만 합니다 — 승격은 반복 실측 후 별도로 판단합니다.
      </span>
      <ul className="flex flex-col gap-2">
        {proposals.map((proposal, index) => (
          <li key={index} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-mono">
                {proposal.proposedDimension}
              </Badge>
            </div>
            <p className="mt-1.5 text-sm">{proposal.rationale}</p>
            <p className="mt-1 text-xs text-muted-foreground">인용: “{proposal.exampleSpan}”</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 실행 메타 — 입력 블럭·해시·토큰 사용량·비용. */
function RunMeta({ run }: { run: LabRun }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>입력 블럭</TableHead>
              <TableHead className="text-right">chars</TableHead>
              <TableHead>truncated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.inputBlocks.map((block, index) => (
              <TableRow key={index}>
                <TableCell className="font-medium break-words">{block.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {block.chars.toLocaleString()}
                </TableCell>
                <TableCell>
                  {block.truncated ? (
                    <Badge variant="destructive">잘림</Badge>
                  ) : (
                    <Badge variant="outline">전체</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <MetaItem label="입력 총 chars" value={run.inputTotalChars.toLocaleString()} />
        <MetaItem label="입력 sha256" value={run.inputSha256} mono />
        <MetaItem
          label="토큰 사용량"
          value={
            run.usage
              ? `input ${run.usage.inputTokens.toLocaleString()} · output ${run.usage.outputTokens.toLocaleString()}${
                  run.usage.cacheReadTokens !== null
                    ? ` · cache read ${run.usage.cacheReadTokens.toLocaleString()}`
                    : ""
                }`
              : "—"
          }
        />
        <MetaItem label="비용" value={formatUsd(run.costUsd)} />
        <MetaItem label="소요 시간" value={formatDuration(run.durationMs)} />
        <MetaItem label="모델" value={run.model} mono />
        <MetaItem label="프롬프트 버전" value={run.promptVersion} mono />
        <MetaItem label="오류" value={run.error ?? "없음"} />
      </dl>
    </div>
  );
}

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs break-all" : "break-words"}>{value}</dd>
    </div>
  );
}

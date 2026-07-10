"use client";

import { useMemo, useState } from "react";
import type { ComponentProps } from "react";
import { AlertTriangle, Archive, CalendarClock, CheckCircle2, Download, FileText, Loader2, Mail, Save, Send, UserRound, XCircle } from "lucide-react";
import type { FeedbackKind } from "@cunote/contracts";
import type {
  ApplicationPipelineItem,
  ApplicationPipelineResult,
  ApplicationStage,
} from "@/lib/server/applications/pipeline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const STAGES: Array<{
  stage: ApplicationStage;
  title: string;
  description: string;
}> = [
  { stage: "preparing", title: "서류 준비", description: "초안 또는 준비 기록이 있는 공고" },
  { stage: "saved", title: "저장됨", description: "검토 대상으로 저장한 공고" },
  { stage: "recommended", title: "추천", description: "현재 조건 기준으로 검토할 공고" },
  { stage: "submitted", title: "제출 완료", description: "제출했거나 결과를 기다리는 공고" },
  { stage: "selected", title: "선정", description: "최종 선정된 공고" },
  { stage: "rejected", title: "탈락", description: "제출했지만 선정되지 않은 공고" },
  { stage: "blocked", title: "신청 막힘", description: "포털·조건·서류 단계에서 막힌 공고" },
  { stage: "dismissed", title: "보류", description: "이번 라운드에서 제외한 공고" },
];

export function ApplicationPipelineView({
  pipeline,
}: {
  pipeline: ApplicationPipelineResult;
}) {
  const [items, setItems] = useState(pipeline.items);
  const [managementDrafts, setManagementDrafts] = useState<Record<string, ManagementDraft>>(() =>
    Object.fromEntries(pipeline.items.map((item) => [item.grantId, managementDraftFromItem(item)]))
  );
  const [pendingGrantId, setPendingGrantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stats = useMemo(() => buildStats(items), [items]);
  const [activeStage, setActiveStage] = useState<ApplicationStage>(() => initialActiveStage(pipeline.items));

  async function moveItem(item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) {
    setPendingGrantId(item.grantId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/matches/${encodeURIComponent(item.grantId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, message: `pipeline:${stage}` }),
      });
      const payload = await response.json() as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "상태를 저장하지 못했습니다.");
      setItems((current) => current.map((candidate) =>
        candidate.grantId === item.grantId
          ? {
            ...candidate,
            stage,
            stageLabel: stageLabel(stage),
            lastActionAt: new Date().toISOString(),
          }
          : candidate
      ));
      setNotice(`${item.title}을(를) ${stageLabel(stage)} 단계로 이동했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "상태를 저장하지 못했습니다.");
    } finally {
      setPendingGrantId(null);
    }
  }

  async function saveManagement(item: ApplicationPipelineItem) {
    const draft = managementDrafts[item.grantId] ?? managementDraftFromItem(item);
    setPendingGrantId(item.grantId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/matches/${encodeURIComponent(item.grantId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: feedbackKindForStage(item.stage),
          message: `pipeline:management:${item.stage}`,
          payload: {
            source: "application_pipeline",
            assigneeName: optionalPayloadString(draft.assigneeName),
            reminderAt: draft.reminderAt || null,
            outcomeNote: optionalPayloadString(draft.outcomeNote),
          },
        }),
      });
      const payload = await response.json() as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "후속 관리 정보를 저장하지 못했습니다.");
      const savedDraft = normalizeManagementDraft(draft);
      setItems((current) => current.map((candidate) =>
        candidate.grantId === item.grantId
          ? {
            ...candidate,
            assigneeName: savedDraft.assigneeName || null,
            reminderAt: savedDraft.reminderAt || null,
            outcomeNote: savedDraft.outcomeNote || null,
            lastActionAt: new Date().toISOString(),
          }
          : candidate
      ));
      setManagementDrafts((current) => ({ ...current, [item.grantId]: savedDraft }));
      setNotice(`${item.title}의 담당자, 리마인더, 후속 메모를 저장했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "후속 관리 정보를 저장하지 못했습니다.");
    } finally {
      setPendingGrantId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">신청 관리</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
              지원사업을 신청 파이프라인으로 관리하세요
            </h1>
            <p className="text-base leading-7 text-muted-foreground">
              추천된 공고를 저장, 준비, 제출, 보류 단계로 나눠 현재 작업 상태를 추적합니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a className={buttonVariants({ variant: "secondary" })} href="/api/web/applications/report">
              <Download data-icon="inline-start" />
              리포트
            </a>
            <a className={buttonVariants({ variant: "outline" })} href="/api/web/applications/calendar">
              <CalendarClock data-icon="inline-start" />
              전체 캘린더
            </a>
            <a className={buttonVariants({ variant: "outline" })} href="/api/web/applications/calendar-subscription">
              <CalendarClock data-icon="inline-start" />
              구독 URL
            </a>
            <a className={buttonVariants()} href="/dashboard">새 기회 보기</a>
            <a className={buttonVariants({ variant: "outline" })} href="/roadmap">로드맵</a>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="신청 상태 요약">
          {STAGES.map((stage) => (
            <Card key={stage.stage}>
              <CardHeader>
                <CardDescription>{stage.title}</CardDescription>
                <CardTitle className="text-2xl font-semibold tracking-normal tabular-nums text-foreground">
                  {stats[stage.stage].toLocaleString("ko-KR")}건
                </CardTitle>
              </CardHeader>
            </Card>
          ))}
        </section>

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {notice ? (
          <Alert role="status" aria-live="polite">
            <CheckCircle2 aria-hidden />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="신청 단계 선택">
          {STAGES.map((stage) => (
            <button
              key={stage.stage}
              type="button"
              role="tab"
              aria-selected={activeStage === stage.stage}
              aria-controls={`application-lane-${stage.stage}`}
              className={buttonVariants({
                variant: activeStage === stage.stage ? "default" : "outline",
                size: "sm",
                className: "gap-2",
              })}
              onClick={() => setActiveStage(stage.stage)}
            >
              <span>{stage.title}</span>
              <strong className="tabular-nums">{stats[stage.stage].toLocaleString("ko-KR")}</strong>
            </button>
          ))}
        </div>

        <section className="grid gap-4 xl:grid-cols-2" aria-label="신청 파이프라인" data-application-board data-active-stage={activeStage}>
          {STAGES.map((stage) => {
            const stageItems = items.filter((item) => item.stage === stage.stage);
            return (
              <Card
                className={cn(
                  "min-h-[26rem]",
                  activeStage === stage.stage ? "bg-primary/5 ring-primary/30" : "bg-card"
                )}
                data-active={activeStage === stage.stage}
                data-stage={stage.stage}
                id={`application-lane-${stage.stage}`}
                key={stage.stage}
                role="tabpanel"
                aria-label={`${stage.title} 단계`}
              >
                <CardHeader className="border-b">
                  <CardTitle>{stage.title}</CardTitle>
                  <CardDescription>{stage.description}</CardDescription>
                  <CardAction>
                    <Badge variant={activeStage === stage.stage ? "default" : "secondary"} className="tabular-nums">
                      {stageItems.length}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-4">
                  {stageItems.map((item) => (
                    <PipelineCard
                      key={item.grantId}
                      item={item}
                      draft={managementDrafts[item.grantId] ?? managementDraftFromItem(item)}
                      pending={pendingGrantId === item.grantId}
                      onMove={moveItem}
                      onDraftChange={(draft) => setManagementDrafts((current) => ({
                        ...current,
                        [item.grantId]: draft,
                      }))}
                      onSaveManagement={saveManagement}
                    />
                  ))}
                  {stageItems.length === 0 ? (
                    <Empty className="min-h-56 flex-1 bg-muted/20">
                      <EmptyDescription>이 단계의 공고가 없습니다.</EmptyDescription>
                    </Empty>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </section>
    </div>
  );
}

function PipelineCard({
  item,
  draft,
  pending,
  onMove,
  onDraftChange,
  onSaveManagement,
}: {
  item: ApplicationPipelineItem;
  draft: ManagementDraft;
  pending: boolean;
  onMove: (item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) => Promise<void>;
  onDraftChange: (draft: ManagementDraft) => void;
  onSaveManagement: (item: ApplicationPipelineItem) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="line-clamp-2">{item.title}</CardTitle>
        <CardDescription>{item.agency ?? "기관 확인 필요"}</CardDescription>
        <CardAction>
          <div className="flex flex-col items-end gap-2">
            <Badge variant={stageBadgeVariant(item.stage)}>{item.stageLabel}</Badge>
            <span className="text-xs font-medium text-muted-foreground">{formatDday(item.dDay)}</span>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.fitScore !== null ? (
            <span>적합도 {item.fitScore}</span>
          ) : (
            <Badge variant="outline" className="font-normal">매칭 밖 · 직접 준비</Badge>
          )}
          <span>{item.supportLabel}</span>
          <span>초안 {item.reviewedDraftCount}/{item.draftCount}</span>
          {item.assigneeName ? <span>담당 {item.assigneeName}</span> : null}
          {item.reminderAt ? <span>리마인더 {item.reminderAt}</span> : null}
        </div>
        <p className="rounded-lg bg-muted/50 p-3 text-sm leading-6 text-foreground">{item.nextAction}</p>
        {item.outcomeNote ? (
          <p className="rounded-lg border bg-background p-3 text-sm leading-6 text-muted-foreground">{item.outcomeNote}</p>
        ) : null}
        {isPostSubmitStage(item.stage) ? (
          <form
            className="rounded-lg border bg-background p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onSaveManagement(item);
            }}
          >
            <FieldGroup className="grid gap-3 md:grid-cols-2">
              <Field>
                <FieldLabel>
                  <UserRound aria-hidden />
                  담당자
                </FieldLabel>
                <Input
                  value={draft.assigneeName}
                  onChange={(event) => onDraftChange({ ...draft, assigneeName: event.currentTarget.value })}
                  placeholder="담당자 이름"
                  disabled={pending}
                />
              </Field>
              <Field>
                <FieldLabel>
                  <CalendarClock aria-hidden />
                  리마인더
                </FieldLabel>
                <Input
                  type="date"
                  value={draft.reminderAt}
                  onChange={(event) => onDraftChange({ ...draft, reminderAt: event.currentTarget.value })}
                  disabled={pending}
                />
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel>결과/후속 메모</FieldLabel>
                <Textarea
                  value={draft.outcomeNote}
                  onChange={(event) => onDraftChange({ ...draft, outcomeNote: event.currentTarget.value })}
                  placeholder="발표 예정일, 보완 요청, 선정 후 의무, 탈락 사유를 기록하세요."
                  disabled={pending}
                />
              </Field>
              <Button className="w-fit" type="submit" size="sm" variant="secondary" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                후속 저장
              </Button>
            </FieldGroup>
          </form>
        ) : null}
        {item.lastActionAt ? (
          <time className="text-xs text-muted-foreground" dateTime={item.lastActionAt}>
            최근 변경 {formatDate(item.lastActionAt)}
          </time>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-start gap-2">
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href={item.detailHref}>
          <FileText data-icon="inline-start" />
          상세
        </a>
        {item.applyEnd || item.reminderAt ? (
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/web/applications/${encodeURIComponent(item.grantId)}/calendar`}
            title="마감일과 리마인더를 캘린더 파일로 내려받기"
          >
            <CalendarClock data-icon="inline-start" />
            캘린더
          </a>
        ) : null}
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={`/api/web/grants/${encodeURIComponent(item.grantId)}/package`}
          title="정규화 서류, 첨부 링크, 저장된 초안을 Markdown으로 내려받기"
        >
          <Download data-icon="inline-start" />
          패키지
        </a>
        {item.stage !== "dismissed" ? (
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/web/applications/${encodeURIComponent(item.grantId)}/reminder-email`}
            title="현재 신청 상태와 다음 액션을 이메일 파일로 내려받기"
          >
            <Mail data-icon="inline-start" />
            리마인더 메일
          </a>
        ) : null}
        {item.stage === "submitted" ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => onMove(item, "selected", "selected")}
            >
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <CheckCircle2 data-icon="inline-start" />}
              선정
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onMove(item, "rejected", "rejected")}
            >
              <XCircle data-icon="inline-start" />
              탈락
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onMove(item, "blocked", "blocked")}
            >
              <AlertTriangle data-icon="inline-start" />
              막힘
            </Button>
          </>
        ) : isFinalOutcomeStage(item.stage) ? null : (
          <>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => onMove(item, "saved", "saved")}
            >
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              저장
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => onMove(item, "applied", "submitted")}
            >
              <Send data-icon="inline-start" />
              제출
            </Button>
          </>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="보류로 이동"
          disabled={pending}
          onClick={() => onMove(item, "dismissed", "dismissed")}
        >
          <Archive />
        </Button>
      </CardFooter>
    </Card>
  );
}

function isFinalOutcomeStage(stage: ApplicationStage): boolean {
  return stage === "selected" || stage === "rejected" || stage === "blocked";
}

function isPostSubmitStage(stage: ApplicationStage): boolean {
  return stage === "submitted" || isFinalOutcomeStage(stage);
}

function feedbackKindForStage(stage: ApplicationStage): FeedbackKind {
  if (stage === "selected") return "selected";
  if (stage === "rejected") return "rejected";
  if (stage === "blocked") return "blocked";
  if (stage === "submitted") return "applied";
  if (stage === "dismissed") return "dismissed";
  if (stage === "saved") return "saved";
  return "note";
}

function buildStats(items: ApplicationPipelineItem[]): Record<ApplicationStage, number> {
  return {
    recommended: items.filter((item) => item.stage === "recommended").length,
    saved: items.filter((item) => item.stage === "saved").length,
    preparing: items.filter((item) => item.stage === "preparing").length,
    submitted: items.filter((item) => item.stage === "submitted").length,
    selected: items.filter((item) => item.stage === "selected").length,
    rejected: items.filter((item) => item.stage === "rejected").length,
    blocked: items.filter((item) => item.stage === "blocked").length,
    dismissed: items.filter((item) => item.stage === "dismissed").length,
  };
}

function initialActiveStage(items: ApplicationPipelineItem[]): ApplicationStage {
  return STAGES.find((stage) => items.some((item) => item.stage === stage.stage))?.stage ?? "saved";
}

function stageLabel(stage: ApplicationStage): string {
  if (stage === "recommended") return "추천";
  if (stage === "saved") return "저장";
  if (stage === "preparing") return "준비";
  if (stage === "submitted") return "제출";
  if (stage === "selected") return "선정";
  if (stage === "rejected") return "탈락";
  if (stage === "blocked") return "막힘";
  return "보류";
}

function stageBadgeVariant(stage: ApplicationStage): ComponentProps<typeof Badge>["variant"] {
  if (stage === "rejected" || stage === "blocked") return "destructive";
  if (stage === "preparing") return "outline";
  if (stage === "dismissed") return "secondary";
  return "default";
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

function formatDate(value: string): string {
  // hourCycle 미지정 시 서버(Node ICU)와 브라우저가 오전/AM 표기를 다르게 골라 hydration이 어긋난다.
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

interface ManagementDraft {
  assigneeName: string;
  reminderAt: string;
  outcomeNote: string;
}

function managementDraftFromItem(item: ApplicationPipelineItem): ManagementDraft {
  return {
    assigneeName: item.assigneeName ?? "",
    reminderAt: item.reminderAt ?? "",
    outcomeNote: item.outcomeNote ?? "",
  };
}

function normalizeManagementDraft(draft: ManagementDraft): ManagementDraft {
  return {
    assigneeName: draft.assigneeName.trim().slice(0, 80),
    reminderAt: validDateInput(draft.reminderAt) ? draft.reminderAt : "",
    outcomeNote: draft.outcomeNote.trim().slice(0, 1000),
  };
}

function optionalPayloadString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

function validDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());
}

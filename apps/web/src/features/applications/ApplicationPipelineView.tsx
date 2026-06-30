"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Archive, CalendarClock, CheckCircle2, Download, FileText, Loader2, Mail, Save, Send, UserRound, XCircle } from "lucide-react";
import type { FeedbackKind } from "@cunote/contracts";
import type {
  ApplicationPipelineItem,
  ApplicationPipelineResult,
  ApplicationStage,
} from "@/lib/server/applications/pipeline";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { HeaderUser } from "@/lib/server/auth/session";

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
  user,
}: {
  pipeline: ApplicationPipelineResult;
  user: HeaderUser | null;
}) {
  const [items, setItems] = useState(pipeline.items);
  const [managementDrafts, setManagementDrafts] = useState<Record<string, ManagementDraft>>(() =>
    Object.fromEntries(pipeline.items.map((item) => [item.grantId, managementDraftFromItem(item)]))
  );
  const [pendingGrantId, setPendingGrantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stats = useMemo(() => buildStats(items), [items]);

  async function moveItem(item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) {
    setPendingGrantId(item.grantId);
    setError(null);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "후속 관리 정보를 저장하지 못했습니다.");
    } finally {
      setPendingGrantId(null);
    }
  }

  return (
    <main className="saas-shell applications-shell">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/applications" })} />

      <section className="saas-hero compact">
        <div>
          <p className="eyebrow">신청 관리</p>
          <h1>지원사업을 신청 파이프라인으로 관리하세요</h1>
          <p>추천된 공고를 저장, 준비, 제출, 보류 단계로 나눠 현재 작업 상태를 추적합니다.</p>
        </div>
        <div className="saas-hero-actions">
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

      <section className="application-stats" aria-label="신청 상태 요약">
        {STAGES.map((stage) => (
          <Card className={`application-stat ${stage.stage}`} key={stage.stage} size="sm">
            <CardContent className="p-0">
              <span>{stage.title}</span>
              <strong>{stats[stage.stage].toLocaleString("ko-KR")}건</strong>
            </CardContent>
          </Card>
        ))}
      </section>

      {error ? (
        <div className="document-draft-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <section className="application-board" aria-label="신청 파이프라인">
        {STAGES.map((stage) => {
          const stageItems = items.filter((item) => item.stage === stage.stage);
          return (
            <div className="application-lane" key={stage.stage}>
              <div className="application-lane-head">
                <div>
                  <h2>{stage.title}</h2>
                  <p>{stage.description}</p>
                </div>
                <StatusBadge tone={stageTone(stage.stage)}>{stageItems.length}</StatusBadge>
              </div>
              <div className="application-card-list">
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
                  <Empty className="panel-empty">
                    <EmptyDescription>이 단계의 공고가 없습니다.</EmptyDescription>
                  </Empty>
                ) : null}
              </div>
            </div>
          );
        })}
      </section>
    </main>
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
    <Card className="application-card" size="sm">
      <CardContent className="p-0">
        <div className="application-card-head">
          <StatusBadge tone={stageTone(item.stage)}>{item.stageLabel}</StatusBadge>
          <span>{formatDday(item.dDay)}</span>
        </div>
        <h3>{item.title}</h3>
        <p>{item.agency ?? "기관 확인 필요"}</p>
        <div className="application-card-meta">
          <span>적합도 {item.fitScore}</span>
          <span>{item.supportLabel}</span>
          <span>초안 {item.reviewedDraftCount}/{item.draftCount}</span>
          {item.assigneeName ? <span>담당 {item.assigneeName}</span> : null}
          {item.reminderAt ? <span>리마인더 {item.reminderAt}</span> : null}
        </div>
        <p className="application-next-action">{item.nextAction}</p>
        {item.outcomeNote ? (
          <p className="application-outcome-note">{item.outcomeNote}</p>
        ) : null}
        <div className="application-card-actions">
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
        </div>
        {isPostSubmitStage(item.stage) ? (
          <form
            className="application-management-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onSaveManagement(item);
            }}
          >
            <label>
              <span><UserRound aria-hidden /> 담당자</span>
              <Input
                value={draft.assigneeName}
                onChange={(event) => onDraftChange({ ...draft, assigneeName: event.currentTarget.value })}
                placeholder="담당자 이름"
                disabled={pending}
              />
            </label>
            <label>
              <span><CalendarClock aria-hidden /> 리마인더</span>
              <Input
                type="date"
                value={draft.reminderAt}
                onChange={(event) => onDraftChange({ ...draft, reminderAt: event.currentTarget.value })}
                disabled={pending}
              />
            </label>
            <label className="application-management-note">
              <span>결과/후속 메모</span>
              <Textarea
                value={draft.outcomeNote}
                onChange={(event) => onDraftChange({ ...draft, outcomeNote: event.currentTarget.value })}
                placeholder="발표 예정일, 보완 요청, 선정 후 의무, 탈락 사유를 기록하세요."
                disabled={pending}
              />
            </label>
            <Button type="submit" size="sm" variant="secondary" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              후속 저장
            </Button>
          </form>
        ) : null}
        {item.lastActionAt ? (
          <time dateTime={item.lastActionAt}>최근 변경 {formatDate(item.lastActionAt)}</time>
        ) : null}
      </CardContent>
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

function stageTone(stage: ApplicationStage): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (stage === "preparing") return "warning";
  if (stage === "submitted" || stage === "selected") return "success";
  if (stage === "rejected" || stage === "blocked") return "danger";
  if (stage === "dismissed") return "neutral";
  return "brand";
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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

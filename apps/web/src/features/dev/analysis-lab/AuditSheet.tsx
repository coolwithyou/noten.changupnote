"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LabAudit,
  LabAuditItem,
  LabAuditItemJudgment,
  LabAuditReason,
  LabAuditResponse,
  LabAuditUpsertRequest,
  LabCriterion,
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
  LabRun,
} from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AXIS_VERDICT_META,
  AXIS_VERDICT_ORDER,
  CRITERION_VERDICT_META,
  CRITERION_VERDICT_ORDER,
  REVIEWER_EMAIL_STORAGE_KEY,
} from "./ReviewSheet";
import { criterionValueEntries, formatDateTime, kindBadgeVariant, kindLabel } from "./labels";

// ─────────────────────────────────────────────────────────────────────────────
// 감사 시트 — AI 검수(§9 "AI 전수 + 사람 표본 감사")의 사람 감사 입력·저장 UI.
// 대상은 전수가 아니라 표본이다: ① AI 비-correct 전수 ② missed_condition 플래그 전수
// ③ correct 시드 고정 20% 표본(선정은 서버 audit-store — 최초 로드 시 생성·동결).
// 항목별로 AI 판정에 "동의"하거나 "수정"(판정 뒤집기 — 사유 필수)한다. 감사가 완료되면
// 이 공고의 AI 검수가 게이트 표본에 편입된다(aggregate 방법론 줄에 병기).
// ReviewSheet 의 구조·컴포넌트·가드(로드 실패 시 저장 차단, beforeunload, dirty 통지)를
// 그대로 따른다. DB 쓰기는 없다.
// ─────────────────────────────────────────────────────────────────────────────

const AUDIT_URL = "/api/dev/analysis-lab/audit";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 서버(audit route)의 캡과 동일 — 초과 입력을 maxLength 로 선차단.
const NOTE_MAX_CHARS = 2_000;
const OVERALL_NOTE_MAX_CHARS = 4_000;

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost";

/** 감사 대상 선정 사유 배지 — §9 감사 설계의 세 갈래. */
const AUDIT_REASON_META: Record<LabAuditReason, { label: string; variant: BadgeVariant }> = {
  ai_non_correct: { label: "비-correct 감사", variant: "default" },
  missed_condition_flag: { label: "누락 플래그", variant: "destructive" },
  correct_sample: { label: "correct 표본", variant: "secondary" },
};

/** 항목 키 — 대상 목록이 동결돼 있어 kind+criterionIndex/dimension 이 안정 키다. */
function itemKeyOf(item: LabAuditItem): string {
  return item.kind === "criterion" ? `c-${item.criterionIndex ?? "?"}` : `a-${item.dimension ?? "?"}`;
}

interface AuditDraft {
  /** null=미판정, agree=AI 판정 동의, overturn=수정(판정 선택 + 사유 필수). */
  mode: "agree" | "overturn" | null;
  /** overturn 시 선택한 판정. */
  verdict: string | null;
  note: string;
}

/** 저장된 humanVerdict → 초안 복원(동의/수정 판별은 AI 판정과의 일치 여부). */
function draftFromItem(item: LabAuditItem): AuditDraft {
  if (item.humanVerdict === null) return { mode: null, verdict: null, note: "" };
  if (item.humanVerdict === item.aiVerdict) {
    return { mode: "agree", verdict: null, note: item.note ?? "" };
  }
  return { mode: "overturn", verdict: item.humanVerdict, note: item.note ?? "" };
}

/** 초안의 확정 판정 — agree 면 AI 판정, overturn 이면 선택 판정, 미완성이면 null. */
function draftVerdict(item: LabAuditItem, draft: AuditDraft): string | null {
  if (draft.mode === "agree") return item.aiVerdict;
  if (draft.mode === "overturn") return draft.verdict;
  return null;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

export function AuditSheet({
  run,
  model,
  onSaved,
  onDirtyChange,
}: {
  run: LabRun;
  /** 감사 대상 AI 검수 모델(채택 모델) — 감사 파일 키의 일부. */
  model: string;
  /** 저장 성공 시 호출(선택) — 상위에서 감사 배지를 갱신한다. */
  onSaved?: (() => void) | undefined;
  /** 미저장 판정 여부 통지(선택) — 상위가 분석 완료 시 화면 탈취를 보류하는 데 쓴다. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const [auditorEmail, setAuditorEmail] = useState("");
  const [audit, setAudit] = useState<LabAudit | null>(null);
  const [itemCriteria, setItemCriteria] = useState<Array<LabCriterion | null>>([]);
  const [drafts, setDrafts] = useState<Record<string, AuditDraft>>({});
  const [overallNote, setOverallNote] = useState("");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // "다음 미판정" 점프용 — 항목 키 → DOM 엘리먼트 (ReviewSheet 동형 패턴).
  const itemRefs = useRef(new Map<string, HTMLElement>());

  // 축 → 라벨 매핑 — DIMENSION_LABELS 는 서버 소유라 dimensionDiffs 의 label 을 쓴다.
  const labelByDimension = useMemo(
    () => new Map(run.dimensionDiffs.map((diff) => [diff.dimension, diff.label])),
    [run.dimensionDiffs],
  );

  /** 항목 제목 — criterion 이면 제안 축 라벨, 축 항목이면 축 라벨. */
  const itemLabel = (item: LabAuditItem, criterion: LabCriterion | null): string => {
    if (item.kind === "criterion") {
      if (criterion) return labelByDimension.get(criterion.dimension) ?? criterion.dimension;
      return `criterion #${item.criterionIndex ?? "?"}`;
    }
    if (item.dimension) return labelByDimension.get(item.dimension) ?? item.dimension;
    return "(축 미상)";
  };

  // 감사자 이메일 프리필 — 검수 시트와 같은 저장 키(같은 사람이 검수·감사한다).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(REVIEWER_EMAIL_STORAGE_KEY);
      if (stored) setAuditorEmail((current) => (current.length > 0 ? current : stored));
    } catch {
      // localStorage 접근 불가면 프리필만 생략.
    }
  }, []);

  // 마운트·런 변경 시 감사 로드 — 서버가 없으면 생성한다(대상 목록 동결).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setAudit(null);
    setItemCriteria([]);
    setDrafts({});
    setOverallNote("");
    setLastSavedAt(null);
    setDirty(false);

    void (async () => {
      try {
        const params = new URLSearchParams({ grantId: run.grantId, runId: run.runId, model });
        const response = await fetch(`${AUDIT_URL}?${params.toString()}`);
        if (cancelled) return;
        if (!response.ok) {
          setLoadError(await readErrorMessage(response, "감사 시트를 불러오지 못했습니다."));
          return;
        }
        const data = (await response.json()) as LabAuditResponse;
        if (cancelled) return;
        setAudit(data.audit);
        setItemCriteria(data.itemCriteria);
        setDrafts(
          Object.fromEntries(data.audit.items.map((item) => [itemKeyOf(item), draftFromItem(item)])),
        );
        setOverallNote(data.audit.overallNote ?? "");
        if (data.audit.auditorEmail) setAuditorEmail(data.audit.auditorEmail);
        // createdAt === updatedAt 이면 방금 생성된 시트(저장 이력 없음)다.
        setLastSavedAt(data.audit.updatedAt !== data.audit.createdAt ? data.audit.updatedAt : null);
      } catch {
        if (!cancelled) setLoadError("네트워크 오류로 감사 시트를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [run.grantId, run.runId, model]);

  // 미저장 판정 보호 — 브라우저 이탈 경고 + 부모 통지 (ReviewSheet 선례).
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const emailValid = EMAIL_PATTERN.test(auditorEmail.trim());
  const items = audit?.items ?? [];

  // 진행도 — 판정 확정(동의 또는 수정 판정 선택) 항목 수.
  const decided = items.reduce((count, item) => {
    const draft = drafts[itemKeyOf(item)];
    return draft && draftVerdict(item, draft) !== null ? count + 1 : count;
  }, 0);
  const total = items.length;

  // 서버가 400 으로 거부하는 조합을 미리 잡는다 — 뒤집기(수정)는 사유 필수.
  const missingOverturnNotes = items.filter((item) => {
    const draft = drafts[itemKeyOf(item)];
    return draft?.mode === "overturn" && draft.verdict !== null && draft.note.trim().length === 0;
  }).length;

  // 감사 로드 실패 상태의 저장은 차단 — 검수 시트 사고(2026-07-22) 교훈과 동일 가드.
  // (서버도 감사 파일 없이는 저장을 거부한다 — 이중 가드.)
  const saveBlockedReason = loadError
    ? "감사 시트를 불러오지 못한 상태라 저장이 차단됐습니다 — 새로고침 후 다시 시도하세요."
    : !emailValid
      ? "감사자 이메일을 입력해야 저장할 수 있습니다."
      : decided === 0
        ? "아직 판정한 항목이 없습니다 — 최소 1건 판정 후 저장하세요."
        : missingOverturnNotes > 0
          ? `"수정" 판정 ${missingOverturnNotes}건에 사유가 필요합니다(뒤집기는 사유 필수).`
          : null;

  const registerItem = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) itemRefs.current.set(key, element);
      else itemRefs.current.delete(key);
    },
    [],
  );

  const jumpToNextUndecided = () => {
    const next = items.find((item) => {
      const draft = drafts[itemKeyOf(item)];
      return !draft || draftVerdict(item, draft) === null;
    });
    if (!next) return;
    itemRefs.current.get(itemKeyOf(next))?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const setDraft = (key: string, patch: Partial<AuditDraft>) => {
    setDrafts((previous) => ({
      ...previous,
      [key]: { mode: null, verdict: null, note: "", ...previous[key], ...patch },
    }));
    setDirty(true);
  };

  const save = async () => {
    if (!audit || saveBlockedReason || saving) return;
    setSaving(true);
    setSaveError(null);

    const email = auditorEmail.trim();
    // 판정 확정 항목만 보낸다(부분 저장) — 서버는 저장본 대상 목록에 병합만 한다.
    const judgments: LabAuditItemJudgment[] = audit.items.flatMap((item) => {
      const draft = drafts[itemKeyOf(item)];
      if (!draft) return [];
      const verdict = draftVerdict(item, draft);
      if (verdict === null) return [];
      const note = draft.note.trim();
      return [
        {
          kind: item.kind,
          ...(item.criterionIndex !== undefined ? { criterionIndex: item.criterionIndex } : {}),
          ...(item.dimension !== undefined ? { dimension: item.dimension } : {}),
          humanVerdict: verdict as LabCriterionVerdict | LabEmptyAxisVerdict,
          note: note.length > 0 ? note : null,
        },
      ];
    });
    const body: LabAuditUpsertRequest = {
      grantId: run.grantId,
      runId: run.runId,
      model,
      auditorEmail: email,
      items: judgments,
      overallNote: overallNote.trim().length > 0 ? overallNote.trim() : null,
    };

    try {
      const response = await fetch(AUDIT_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setSaveError(await readErrorMessage(response, "감사 저장에 실패했습니다."));
        return;
      }
      const data = (await response.json()) as LabAuditResponse;
      setAudit(data.audit);
      setItemCriteria(data.itemCriteria);
      setLastSavedAt(data.audit.updatedAt);
      setDirty(false);
      try {
        window.localStorage.setItem(REVIEWER_EMAIL_STORAGE_KEY, email);
      } catch {
        // 저장 자체는 성공 — 프리필 저장 실패는 무시.
      }
      onSaved?.();
    } catch {
      setSaveError("네트워크 오류로 감사를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-10 text-sm text-muted-foreground">
        <Spinner />
        감사 시트를 불러오는 중…
      </div>
    );
  }

  if (loadError && !audit) {
    return (
      <Alert variant="destructive">
        <AlertTitle>감사 시트 로드 실패</AlertTitle>
        <AlertDescription className="break-words">{loadError}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Alert>
        <AlertTitle>표본 감사입니다 — 전수 검수가 아닙니다</AlertTitle>
        <AlertDescription>
          AI 검수({audit?.model ?? model} · {audit?.aiPromptVersion ?? ""}) 중 §9 표본(비-correct
          전수 + 누락 플래그 전수 + correct 20%)만 확인합니다. 감사 완료 시 이 공고의 AI 검수가
          게이트 표본에 편입됩니다.
        </AlertDescription>
      </Alert>

      <Field className="max-w-sm">
        <FieldLabel htmlFor="analysis-lab-auditor-email">감사자 이메일</FieldLabel>
        <Input
          id="analysis-lab-auditor-email"
          type="email"
          placeholder="you@example.com"
          value={auditorEmail}
          aria-invalid={auditorEmail.length > 0 && !emailValid}
          onChange={(event) => {
            setAuditorEmail(event.currentTarget.value);
            setDirty(true);
          }}
        />
        <FieldDescription>
          사람 감사자 본인의 이메일 — AI 라벨러 식별자(prelabel·opus·claude 등)는 서버가
          거부합니다(검수 시트와 동일 가드).
        </FieldDescription>
      </Field>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">감사 대상 {total}건</span>
            <span className="text-xs text-muted-foreground">
              항목별로 공고 원문 대비 AI 판정·사유가 맞는지 확인해 동의하거나 수정(사유 필수)
              합니다.
            </span>
          </div>
          <Badge variant={decided === total && total > 0 ? "default" : "secondary"} className="tabular-nums">
            {decided} / {total}
          </Badge>
        </div>
        {total === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            감사 대상이 없습니다 — 이 런의 AI 검수는 표본에 걸리지 않아 감사 없이 확정
            편입됩니다.
          </p>
        ) : (
          items.map((item, index) => (
            <AuditItemBlock
              key={itemKeyOf(item)}
              item={item}
              criterion={itemCriteria[index] ?? null}
              label={itemLabel(item, itemCriteria[index] ?? null)}
              draft={drafts[itemKeyOf(item)] ?? { mode: null, verdict: null, note: "" }}
              disabled={saving}
              containerRef={registerItem(itemKeyOf(item))}
              onChange={(patch) => setDraft(itemKeyOf(item), patch)}
            />
          ))
        )}
      </div>

      <Separator />

      <Field>
        <FieldLabel htmlFor="analysis-lab-audit-overall-note">전체 메모</FieldLabel>
        <Textarea
          id="analysis-lab-audit-overall-note"
          className="min-h-24"
          placeholder="감사 전반에 대한 총평·특이사항 (선택)"
          value={overallNote}
          maxLength={OVERALL_NOTE_MAX_CHARS}
          disabled={saving}
          onChange={(event) => {
            setOverallNote(event.currentTarget.value);
            setDirty(true);
          }}
        />
      </Field>

      {saveError ? (
        <Alert variant="destructive">
          <AlertTitle>감사 저장 실패</AlertTitle>
          <AlertDescription className="break-words">{saveError}</AlertDescription>
        </Alert>
      ) : null}

      {/* 고정 저장 바 — ReviewSheet 동형. 부분 저장 허용. */}
      <div className="sticky bottom-4 z-10 flex flex-col gap-2.5 rounded-xl border border-border bg-background/95 p-3 shadow-md backdrop-blur">
        <div className="flex items-center gap-3">
          <Progress value={total > 0 ? (decided / total) * 100 : 100} className="flex-1" />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            판정 {decided} / {total}
          </span>
          {decided < total ? (
            <Button variant="ghost" size="sm" onClick={jumpToNextUndecided}>
              다음 미판정 ↓
            </Button>
          ) : total > 0 ? (
            <Badge>전 항목 판정 완료</Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button onClick={() => void save()} disabled={saveBlockedReason !== null || saving}>
            {saving ? (
              <>
                <Spinner data-icon="inline-start" />
                저장 중…
              </>
            ) : (
              "감사 저장"
            )}
          </Button>
          {saveBlockedReason ? (
            <span className="text-xs text-destructive">{saveBlockedReason}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              부분 저장 가능 — 전 항목 판정 시 이 공고가 게이트 표본에 편입됩니다.
            </span>
          )}
          <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
            {dirty ? <Badge variant="secondary">미저장 변경</Badge> : null}
            {lastSavedAt ? `마지막 저장 ${formatDateTime(lastSavedAt)}` : "저장된 감사 없음"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 감사 항목 1건 카드 — AI 판정 스냅샷 + 동의/수정 컨트롤. */
function AuditItemBlock({
  item,
  criterion,
  label,
  draft,
  disabled,
  containerRef,
  onChange,
}: {
  item: LabAuditItem;
  /** kind=criterion 이면 런의 제안 원본(서버 조인), axis 면 null. */
  criterion: LabCriterion | null;
  label: string;
  draft: AuditDraft;
  disabled: boolean;
  containerRef: (element: HTMLElement | null) => void;
  onChange: (patch: Partial<AuditDraft>) => void;
}) {
  const reason = AUDIT_REASON_META[item.reason];
  const aiVerdictMeta =
    item.kind === "criterion"
      ? CRITERION_VERDICT_META[item.aiVerdict as LabCriterionVerdict]
      : AXIS_VERDICT_META[item.aiVerdict as LabEmptyAxisVerdict];
  // 수정(뒤집기) 선택지 — AI 판정 자체는 "동의"와 같으므로 제외한다.
  const overturnOptions: readonly string[] = (
    item.kind === "criterion" ? CRITERION_VERDICT_ORDER : AXIS_VERDICT_ORDER
  ).filter((verdict) => verdict !== item.aiVerdict);
  const verdictLabel = (verdict: string): string =>
    item.kind === "criterion"
      ? (CRITERION_VERDICT_META[verdict as LabCriterionVerdict]?.label ?? verdict)
      : (AXIS_VERDICT_META[verdict as LabEmptyAxisVerdict]?.label ?? verdict);
  const decidedVerdict = draftVerdict(item, draft);

  return (
    <section
      ref={containerRef}
      className="min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-border"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">
            {item.kind === "criterion" ? `#${(item.criterionIndex ?? 0) + 1} ${label}` : label}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {item.kind === "criterion" ? criterion?.dimension : item.dimension}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={reason.variant}>{reason.label}</Badge>
          {criterion ? (
            <>
              <Badge variant={kindBadgeVariant(criterion.kind)}>{kindLabel(criterion.kind)}</Badge>
              <Badge variant="outline" className="font-mono">
                {criterion.operator}
              </Badge>
            </>
          ) : null}
          {decidedVerdict !== null ? (
            decidedVerdict === item.aiVerdict ? (
              <Badge>동의</Badge>
            ) : (
              <Badge variant="destructive">수정 → {verdictLabel(decidedVerdict)}</Badge>
            )
          ) : (
            <Badge variant="ghost">미판정</Badge>
          )}
        </div>
      </header>
      <div className="flex min-w-0 flex-col gap-2.5 p-3">
        {criterion ? (
          <>
            <ValueLines value={criterion.value} />
            {criterion.sourceSpan ? (
              <blockquote className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                근거: “{criterion.sourceSpan}”
              </blockquote>
            ) : (
              <p className="text-[11px] text-muted-foreground">근거 인용 없음</p>
            )}
          </>
        ) : null}

        {/* AI 판정 스냅샷 — 감사의 대상. */}
        <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-muted/20 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">AI 판정</span>
            {aiVerdictMeta ? (
              <Badge variant={aiVerdictMeta.badge}>{aiVerdictMeta.label}</Badge>
            ) : (
              <Badge variant="outline" className="font-mono">
                {item.aiVerdict}
              </Badge>
            )}
          </div>
          {item.aiNote ? (
            <p className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
              AI 사유: {item.aiNote}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">AI 사유 없음</p>
          )}
        </div>

        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={draft.mode ? [draft.mode] : []}
          onValueChange={(values) => {
            const next = (values.at(-1) as AuditDraft["mode"] | undefined) ?? null;
            onChange({ mode: next, ...(next !== "overturn" ? { verdict: null } : {}) });
          }}
          disabled={disabled}
          aria-label="감사 판정"
        >
          <ToggleGroupItem value="agree">동의</ToggleGroupItem>
          <ToggleGroupItem value="overturn">수정</ToggleGroupItem>
        </ToggleGroup>

        {draft.mode === "overturn" ? (
          <>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={1}
              value={draft.verdict ? [draft.verdict] : []}
              onValueChange={(values) => {
                const next = (values.at(-1) as string | undefined) ?? null;
                onChange({ verdict: next });
              }}
              disabled={disabled}
              aria-label="수정 판정 선택"
            >
              {overturnOptions.map((verdict) => (
                <ToggleGroupItem key={verdict} value={verdict}>
                  {verdictLabel(verdict)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Textarea
              className="min-h-20"
              placeholder="AI 판정을 왜 뒤집는지 — 원문 근거와 올바른 판정을 서술 (필수)"
              value={draft.note}
              maxLength={NOTE_MAX_CHARS}
              aria-invalid={draft.verdict !== null && draft.note.trim().length === 0}
              disabled={disabled}
              onChange={(event) => onChange({ note: event.currentTarget.value })}
            />
          </>
        ) : draft.mode === "agree" ? (
          <p className="text-[11px] text-muted-foreground">
            AI 판정에 동의합니다 — 저장 시 AI 판정이 사람 확인 판정으로 기록됩니다.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            공고 원문과 대조해 AI 판정·사유가 맞으면 동의, 틀리면 수정을 선택하세요.
          </p>
        )}
      </div>
    </section>
  );
}

/** criterion value 를 key-value 줄로 렌더 — ReviewSheet 의 ValueLines 와 동형. */
function ValueLines({ value }: { value: unknown }) {
  const entries = criterionValueEntries(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {entries.map((entry, index) => (
        <div key={index} className="flex min-w-0 gap-1.5 text-xs">
          {entry.key ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {entry.key}
            </span>
          ) : null}
          <span className="min-w-0 break-all">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

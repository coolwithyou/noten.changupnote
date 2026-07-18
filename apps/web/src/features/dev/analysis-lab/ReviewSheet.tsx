"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  LabCriterion,
  LabCriterionVerdict,
  LabDimensionDiff,
  LabEmptyAxisVerdict,
  LabReviewResponse,
  LabReviewUpsertRequest,
  LabRun,
} from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AXIS_STATUS_META,
  criterionValueEntries,
  formatDateTime,
  kindBadgeVariant,
  kindLabel,
} from "./labels";

// ─────────────────────────────────────────────────────────────────────────────
// 검수 시트 — 딥분석 런 1건에 대한 사람 검수(창업자) 입력·저장 UI.
// 런은 불변이므로 criterionIndex 가 안정 키다. 검수 파일은 런 옆 <runId>.review.json 에
// 저장되며(덮어쓰기 허용), 이 검수가 공고 criterion 골든셋의 1차 원천이 된다.
// Gate 1 원칙: AI 라벨러의 검수 금지 — 사람 이메일을 강제한다. DB 쓰기는 없다.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW_URL = "/api/dev/analysis-lab/review";
const REVIEWER_EMAIL_STORAGE_KEY = "analysis-lab.reviewerEmail";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 제안 criterion 판정 라벨 — contract 의 LabCriterionVerdict 순서와 일치. */
const CRITERION_VERDICT_OPTIONS: Array<{ value: LabCriterionVerdict; label: string }> = [
  { value: "correct", label: "정확" },
  { value: "needs_edit", label: "수정 필요" },
  { value: "wrong", label: "오류" },
  { value: "unsure", label: "판단 불가" },
];

/** 제안 없는 축 확인 라벨. */
const AXIS_VERDICT_OPTIONS: Array<{ value: LabEmptyAxisVerdict; label: string }> = [
  { value: "confirmed_absent", label: "없음 확인" },
  { value: "missed_condition", label: "누락 있음" },
];

interface CriterionDraft {
  verdict: LabCriterionVerdict | null;
  note: string;
}

interface AxisDraft {
  verdict: LabEmptyAxisVerdict | null;
  note: string;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

export function ReviewSheet({
  run,
  onSaved,
}: {
  run: LabRun;
  /** 저장 성공 시 호출(선택) — 상위에서 런 목록의 검수됨 표시를 갱신한다. */
  onSaved?: (() => void) | undefined;
}) {
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [criterionDrafts, setCriterionDrafts] = useState<Record<number, CriterionDraft>>({});
  const [axisDrafts, setAxisDrafts] = useState<Record<string, AxisDraft>>({});
  const [overallNote, setOverallNote] = useState("");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // 축 → 라벨 매핑 — DIMENSION_LABELS 는 서버(diff.ts) 소유라 dimensionDiffs 의 label 을 쓴다.
  const labelByDimension = useMemo(
    () => new Map(run.dimensionDiffs.map((diff) => [diff.dimension, diff.label])),
    [run.dimensionDiffs],
  );

  // 섹션 B 대상 — 딥분석 제안이 없는 축(재현율·누락 골든 신호). 서버는 이 축만 허용한다.
  const emptyAxes = useMemo(
    () => run.dimensionDiffs.filter((diff) => diff.proposed.length === 0),
    [run.dimensionDiffs],
  );

  // 검수자 이메일 프리필 — 기존 검수가 있으면 로드 시 그 이메일이 우선한다.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(REVIEWER_EMAIL_STORAGE_KEY);
      if (stored) setReviewerEmail((current) => (current.length > 0 ? current : stored));
    } catch {
      // localStorage 접근 불가(프라이빗 모드 등)면 프리필만 생략한다.
    }
  }, []);

  // 마운트·런 변경 시 기존 검수 로드 — 없으면 빈 시트.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setCriterionDrafts({});
    setAxisDrafts({});
    setOverallNote("");
    setLastSavedAt(null);
    setDirty(false);

    void (async () => {
      try {
        const params = new URLSearchParams({ grantId: run.grantId, runId: run.runId });
        const response = await fetch(`${REVIEW_URL}?${params.toString()}`);
        if (cancelled) return;
        if (!response.ok) {
          setLoadError(await readErrorMessage(response, "기존 검수를 불러오지 못했습니다."));
          return;
        }
        const data = (await response.json()) as LabReviewResponse;
        if (cancelled || !data.review) return;
        const review = data.review;
        setReviewerEmail(review.reviewerEmail);
        setLastSavedAt(review.updatedAt);
        setCriterionDrafts(
          Object.fromEntries(
            review.criterionReviews.map((item) => [
              item.criterionIndex,
              { verdict: item.verdict, note: item.note ?? "" } satisfies CriterionDraft,
            ]),
          ),
        );
        setAxisDrafts(
          Object.fromEntries(
            review.axisReviews.map((item) => [
              item.dimension,
              { verdict: item.verdict, note: item.note ?? "" } satisfies AxisDraft,
            ]),
          ),
        );
        setOverallNote(review.overallNote ?? "");
      } catch {
        if (!cancelled) setLoadError("네트워크 오류로 기존 검수를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [run.grantId, run.runId]);

  const emailValid = EMAIL_PATTERN.test(reviewerEmail.trim());

  // 진행도 — 전체 = 제안 criteria 수 + 제안 없는 축 수.
  const total = run.criteria.length + emptyAxes.length;
  const decided =
    run.criteria.reduce(
      (count, _, index) => (criterionDrafts[index]?.verdict ? count + 1 : count),
      0,
    ) +
    emptyAxes.reduce(
      (count, diff) => (axisDrafts[diff.dimension]?.verdict ? count + 1 : count),
      0,
    );

  const setCriterionDraft = (index: number, patch: Partial<CriterionDraft>) => {
    setCriterionDrafts((previous) => ({
      ...previous,
      [index]: { verdict: null, note: "", ...previous[index], ...patch },
    }));
    setDirty(true);
  };

  const setAxisDraft = (dimension: string, patch: Partial<AxisDraft>) => {
    setAxisDrafts((previous) => ({
      ...previous,
      [dimension]: { verdict: null, note: "", ...previous[dimension], ...patch },
    }));
    setDirty(true);
  };

  const save = async () => {
    if (!emailValid || saving) return;
    setSaving(true);
    setSaveError(null);

    const email = reviewerEmail.trim();
    const body: LabReviewUpsertRequest = {
      grantId: run.grantId,
      runId: run.runId,
      reviewerEmail: email,
      // 판정된 항목만 보낸다 — 부분 검수 저장 허용. note 는 빈 문자열이면 null.
      criterionReviews: run.criteria.flatMap((_, index) => {
        const draft = criterionDrafts[index];
        if (!draft?.verdict) return [];
        const note = draft.verdict === "correct" ? "" : draft.note.trim();
        return [{ criterionIndex: index, verdict: draft.verdict, note: note.length > 0 ? note : null }];
      }),
      // 서버는 "제안 없는 축"만 허용한다 — emptyAxes 기준으로만 구성.
      axisReviews: emptyAxes.flatMap((diff) => {
        const draft = axisDrafts[diff.dimension];
        if (!draft?.verdict) return [];
        const note = draft.verdict === "missed_condition" ? draft.note.trim() : "";
        return [{ dimension: diff.dimension, verdict: draft.verdict, note: note.length > 0 ? note : null }];
      }),
      overallNote: overallNote.trim().length > 0 ? overallNote.trim() : null,
    };

    try {
      const response = await fetch(REVIEW_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setSaveError(await readErrorMessage(response, "검수 저장에 실패했습니다."));
        return;
      }
      const data = (await response.json()) as LabReviewResponse;
      setLastSavedAt(data.review?.updatedAt ?? new Date().toISOString());
      setDirty(false);
      try {
        window.localStorage.setItem(REVIEWER_EMAIL_STORAGE_KEY, email);
      } catch {
        // 저장 자체는 성공 — 프리필 저장 실패는 무시.
      }
      onSaved?.();
    } catch {
      setSaveError("네트워크 오류로 검수를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-10 text-sm text-muted-foreground">
        <Spinner />
        기존 검수를 불러오는 중…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Alert>
        <AlertTitle>사람 검수만 허용</AlertTitle>
        <AlertDescription>
          이 검수가 공고 criterion 골든셋의 1차 원천이 됩니다. AI 라벨러 식별자는 서버가
          거부합니다.
        </AlertDescription>
      </Alert>

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>기존 검수 로드 실패</AlertTitle>
          <AlertDescription className="break-words">
            {loadError} — 새로 작성해 저장하면 덮어씁니다.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field className="max-w-sm">
          <FieldLabel htmlFor="analysis-lab-reviewer-email">검수자 이메일</FieldLabel>
          <Input
            id="analysis-lab-reviewer-email"
            type="email"
            placeholder="you@example.com"
            value={reviewerEmail}
            aria-invalid={reviewerEmail.length > 0 && !emailValid}
            onChange={(event) => {
              setReviewerEmail(event.currentTarget.value);
              setDirty(true);
            }}
          />
          <FieldDescription>사람 검수자 본인의 이메일을 입력합니다.</FieldDescription>
        </Field>
        <Badge variant={decided === total && total > 0 ? "default" : "secondary"} className="tabular-nums">
          판정 {decided} / 전체 {total}
        </Badge>
      </div>

      {/* 섹션 A — 제안 criterion 검수 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">제안 criterion 검수 ({run.criteria.length}건)</span>
          <span className="text-xs text-muted-foreground">
            딥분석이 제안한 criterion 을 하나씩 판정합니다 — 정밀도(오추출) 골든 신호입니다.
          </span>
        </div>
        {run.criteria.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            이 런에는 제안된 criterion 이 없습니다.
          </p>
        ) : (
          run.criteria.map((criterion, index) => (
            <CriterionReviewBlock
              key={index}
              index={index}
              criterion={criterion}
              label={labelByDimension.get(criterion.dimension) ?? criterion.dimension}
              draft={criterionDrafts[index] ?? { verdict: null, note: "" }}
              disabled={saving}
              onChange={(patch) => setCriterionDraft(index, patch)}
            />
          ))
        )}
      </div>

      {/* 섹션 B — 제안 없는 축 확인 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">제안 없는 축 확인 ({emptyAxes.length}건)</span>
          <span className="text-xs text-muted-foreground">
            딥분석 제안이 없는 축에 실제로 요건이 없는지 확인합니다 — 재현율(누락) 골든
            신호입니다.
          </span>
        </div>
        {emptyAxes.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            모든 축에 제안이 있습니다 — 확인할 축이 없습니다.
          </p>
        ) : (
          emptyAxes.map((diff) => (
            <EmptyAxisReviewBlock
              key={diff.dimension}
              diff={diff}
              draft={axisDrafts[diff.dimension] ?? { verdict: null, note: "" }}
              disabled={saving}
              onChange={(patch) => setAxisDraft(diff.dimension, patch)}
            />
          ))
        )}
      </div>

      <Separator />

      <Field>
        <FieldLabel htmlFor="analysis-lab-overall-note">전체 메모</FieldLabel>
        <Textarea
          id="analysis-lab-overall-note"
          className="min-h-24"
          placeholder="런 전반에 대한 총평·특이사항 (선택)"
          value={overallNote}
          disabled={saving}
          onChange={(event) => {
            setOverallNote(event.currentTarget.value);
            setDirty(true);
          }}
        />
      </Field>

      {saveError ? (
        <Alert variant="destructive">
          <AlertTitle>검수 저장 실패</AlertTitle>
          <AlertDescription className="break-words">{saveError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={!emailValid || saving}>
          {saving ? (
            <>
              <Spinner data-icon="inline-start" />
              저장 중…
            </>
          ) : (
            "검수 저장"
          )}
        </Button>
        <span className="text-xs text-muted-foreground">
          {lastSavedAt ? `마지막 저장 ${formatDateTime(lastSavedAt)}` : "저장된 검수 없음"}
        </span>
        {dirty ? <Badge variant="secondary">미저장 변경</Badge> : null}
      </div>
    </div>
  );
}

/** 섹션 A 카드 블럭 — 제안 criterion 1건 + 판정 ToggleGroup. */
function CriterionReviewBlock({
  index,
  criterion,
  label,
  draft,
  disabled,
  onChange,
}: {
  index: number;
  criterion: LabCriterion;
  label: string;
  draft: CriterionDraft;
  disabled: boolean;
  onChange: (patch: Partial<CriterionDraft>) => void;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">
            #{index + 1} {label}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{criterion.dimension}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={kindBadgeVariant(criterion.kind)}>{kindLabel(criterion.kind)}</Badge>
          <Badge variant="outline" className="font-mono">
            {criterion.operator}
          </Badge>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            신뢰도 {Math.round(criterion.confidence * 100)}%
          </span>
          {criterion.spanVerified ? null : <Badge variant="destructive">근거 미확인</Badge>}
        </div>
      </header>
      <div className="flex min-w-0 flex-col gap-2.5 p-3">
        <ValueLines value={criterion.value} />
        {criterion.sourceSpan ? (
          <blockquote className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
            근거: “{criterion.sourceSpan}”
          </blockquote>
        ) : (
          <p className="text-[11px] text-muted-foreground">근거 인용 없음</p>
        )}
        {criterion.note ? (
          <p className="text-[11px] text-muted-foreground">비고: {criterion.note}</p>
        ) : null}
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={draft.verdict ? [draft.verdict] : []}
          onValueChange={(values) => {
            const next = (values.at(-1) as LabCriterionVerdict | undefined) ?? null;
            onChange({ verdict: next });
          }}
          disabled={disabled}
          aria-label="criterion 판정"
        >
          {CRITERION_VERDICT_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {draft.verdict && draft.verdict !== "correct" ? (
          <Textarea
            className="min-h-20"
            placeholder="무엇이 틀렸고 어떻게 고쳐야 하는지"
            value={draft.note}
            disabled={disabled}
            onChange={(event) => onChange({ note: event.currentTarget.value })}
          />
        ) : null}
      </div>
    </section>
  );
}

/** 섹션 B 행 블럭 — 제안 없는 축 1건 + 없음 확인/누락 있음 ToggleGroup. */
function EmptyAxisReviewBlock({
  diff,
  draft,
  disabled,
  onChange,
}: {
  diff: LabDimensionDiff;
  draft: AxisDraft;
  disabled: boolean;
  onChange: (patch: Partial<AxisDraft>) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{diff.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{diff.dimension}</span>
          {diff.assessment ? (
            <Badge variant={AXIS_STATUS_META[diff.assessment.status].variant}>
              {AXIS_STATUS_META[diff.assessment.status].label}
            </Badge>
          ) : (
            <Badge variant="ghost">검사 없음</Badge>
          )}
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={draft.verdict ? [draft.verdict] : []}
          onValueChange={(values) => {
            const next = (values.at(-1) as LabEmptyAxisVerdict | undefined) ?? null;
            onChange({ verdict: next });
          }}
          disabled={disabled}
          aria-label={`${diff.label} 축 확인`}
        >
          {AXIS_VERDICT_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {draft.verdict === "missed_condition" ? (
        <Textarea
          className="min-h-20"
          placeholder="원문 기준으로 누락된 요건 서술"
          value={draft.note}
          disabled={disabled}
          onChange={(event) => onChange({ note: event.currentTarget.value })}
        />
      ) : null}
    </section>
  );
}

/** criterion value 를 key-value 줄로 렌더 — DimensionDiffTable 의 ValueLines 와 동형. */
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

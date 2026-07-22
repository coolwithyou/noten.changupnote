"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleHelp } from "lucide-react";
import {
  ANALYSIS_LAB_GATES,
  type LabCriterion,
  type LabCriterionVerdict,
  type LabDimensionDiff,
  type LabEmptyAxisVerdict,
  type LabReviewResponse,
  type LabReviewUpsertRequest,
  type LabRun,
} from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
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
/** 통과 기준(게이트) 수 — contract 의 ANALYSIS_LAB_GATES 가 단일 원천. */
const GATE_COUNT = Object.keys(ANALYSIS_LAB_GATES).length;
/** 검수자 이메일 프리필 저장 키 — 감사 시트(AuditSheet)와 공유(같은 사람이 검수·감사한다). */
export const REVIEWER_EMAIL_STORAGE_KEY = "analysis-lab.reviewerEmail";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 서버(review route)의 캡과 동일 — 초과 입력을 maxLength 로 선차단해 저장 시점 400 을 막는다.
const NOTE_MAX_CHARS = 2_000;
const OVERALL_NOTE_MAX_CHARS = 4_000;

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost";

/** 제안 criterion 판정 메타 — 라벨·배지·판정 기준 힌트의 단일 원천(감사 시트도 공유). */
export const CRITERION_VERDICT_META: Record<
  LabCriterionVerdict,
  { label: string; badge: BadgeVariant; hint: string }
> = {
  correct: {
    label: "정확",
    badge: "default",
    hint: "축·종류(필수/우대/결격)·연산자·값·근거 인용까지 원문과 모두 일치 — 이대로 DB에 넣어도 되는 수준입니다.",
  },
  needs_edit: {
    label: "수정 필요",
    badge: "secondary",
    hint: "요건 자체는 원문에 실재하지만 값·연산자·종류 일부가 부정확합니다 — 어떻게 고쳐야 하는지 사유에 적어주세요.",
  },
  wrong: {
    label: "오류",
    badge: "destructive",
    hint: "원문에 없는 요건을 만들었거나 다른 조건을 잘못 읽었습니다 — 치명 신호로 집계됩니다(기준 ≤ 10%).",
  },
  unsure: {
    label: "판단 불가",
    badge: "outline",
    hint: "원문·첨부만으로는 확정할 수 없습니다 — 정밀도 분모에 포함되니 꼭 필요할 때만 쓰세요.",
  },
};

/** 제안 없는 축 확인 메타(감사 시트도 공유). */
export const AXIS_VERDICT_META: Record<
  LabEmptyAxisVerdict,
  { label: string; badge: BadgeVariant; hint: string }
> = {
  confirmed_absent: {
    label: "없음 확인",
    badge: "outline",
    hint: "공고 원문·첨부를 훑어도 이 축에 해당하는 요건이 정말 없습니다.",
  },
  missed_condition: {
    label: "누락 있음",
    badge: "destructive",
    hint: "원문에 요건이 있는데 딥분석이 놓쳤습니다 — 누락된 요건 서술이 필수입니다(비워두면 저장되지 않습니다).",
  },
};

export const CRITERION_VERDICT_ORDER: readonly LabCriterionVerdict[] = [
  "correct",
  "needs_edit",
  "wrong",
  "unsure",
];
export const AXIS_VERDICT_ORDER: readonly LabEmptyAxisVerdict[] = [
  "confirmed_absent",
  "missed_condition",
];

/** 판정별 사유 textarea 플레이스홀더 — 무엇을 적어야 하는지 그 자리에서 안내한다. */
const CRITERION_NOTE_PLACEHOLDER: Record<Exclude<LabCriterionVerdict, "correct">, string> = {
  needs_edit: "무엇이 부정확한지 + 올바른 값·연산자·종류 (원문 기준)",
  wrong: "원문 기준으로 무엇이 왜 틀렸는지",
  unsure: "무엇이 불확실한지 · 확정하려면 무엇이 더 필요한지",
};

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
  onDirtyChange,
}: {
  run: LabRun;
  /** 저장 성공 시 호출(선택) — 상위에서 런 목록의 검수됨 표시를 갱신한다. */
  onSaved?: (() => void) | undefined;
  /** 미저장 판정 여부 통지(선택) — 상위가 분석 완료 시 화면 탈취를 보류하는 데 쓴다. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
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
  // 검수 안내 — 이 런에 저장된 검수가 없으면 펼쳐서 시작한다(로드 후 결정).
  const [guideOpen, setGuideOpen] = useState(false);

  // "다음 미판정" 점프용 — 항목 키(c-<index> / a-<dimension>) → DOM 엘리먼트.
  const itemRefs = useRef(new Map<string, HTMLElement>());

  // 검수 시작 시각 계측 — 이 런의 검수 시트가 (이 세션에서) 처음 열린 시각.
  // 저장 시 startedAt 으로 보내며, 서버(review-store)가 최초 저장 값을 보존한다.
  const startedAtRef = useRef<string | null>(null);

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
    // 런이 바뀌면 검수 시작 시각도 새로 계측한다 (같은 런 재방문 시각은 서버가 최초값으로 무시).
    startedAtRef.current = new Date().toISOString();
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
        if (cancelled) return;
        setGuideOpen(!data.review);
        if (!data.review) return;
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

  // 미저장 판정이 있는 채로 페이지를 닫으면 유실 — 브라우저 이탈 경고를 건다.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // dirty 를 부모에 통지 — 인앱 자동 전환(분석 완료 등)으로부터 초안을 보호하는 신호.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const emailValid = EMAIL_PATTERN.test(reviewerEmail.trim());

  // 진행도 — 전체 = 제안 criteria 수 + 제안 없는 축 수.
  const decidedA = run.criteria.reduce(
    (count, _, index) => (criterionDrafts[index]?.verdict ? count + 1 : count),
    0,
  );
  const decidedB = emptyAxes.reduce(
    (count, diff) => (axisDrafts[diff.dimension]?.verdict ? count + 1 : count),
    0,
  );
  const decided = decidedA + decidedB;
  const total = run.criteria.length + emptyAxes.length;

  // 서버가 400 으로 거부하는 조합을 미리 잡는다 — "누락 있음"은 사유 필수.
  const missingAxisNotes = emptyAxes.filter((diff) => {
    const draft = axisDrafts[diff.dimension];
    return draft?.verdict === "missed_condition" && draft.note.trim().length === 0;
  }).length;

  // 기존 검수 로드 실패 상태의 저장은 차단한다 — 빈 초안 위에 저장하면 기존 검수가
  // 조용히 덮인다(2026-07-22 실사고: 파일럿 needs_edit 판정 소실). 새로고침으로 재시도.
  const saveBlockedReason = loadError
    ? "기존 검수를 불러오지 못한 상태라 저장이 차단됐습니다 — 저장하면 기존 검수를 덮어씁니다. 새로고침 후 다시 시도하세요."
    : !emailValid
      ? "검수자 이메일을 입력해야 저장할 수 있습니다."
      : decided === 0
        ? "아직 판정한 항목이 없습니다 — 최소 1건 판정 후 저장하세요."
        : missingAxisNotes > 0
          ? `"누락 있음" 판정 ${missingAxisNotes}건에 누락 요건 서술이 필요합니다.`
          : null;

  const registerItem = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) itemRefs.current.set(key, element);
      else itemRefs.current.delete(key);
    },
    [],
  );

  const jumpToNextUndecided = () => {
    const order = [
      ...run.criteria.map((_, index) => ({
        key: `c-${index}`,
        done: Boolean(criterionDrafts[index]?.verdict),
      })),
      ...emptyAxes.map((diff) => ({
        key: `a-${diff.dimension}`,
        done: Boolean(axisDrafts[diff.dimension]?.verdict),
      })),
    ];
    const next = order.find((item) => !item.done);
    if (!next) return;
    itemRefs.current.get(next.key)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

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
    if (saveBlockedReason || saving) return;
    setSaving(true);
    setSaveError(null);

    const email = reviewerEmail.trim();
    const body: LabReviewUpsertRequest = {
      grantId: run.grantId,
      runId: run.runId,
      reviewerEmail: email,
      // 검수 시작 시각 — 공고당 실검수 시간 지표. 최초 저장 값이 보존된다(서버 소관).
      startedAt: startedAtRef.current,
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

  // 실패한 런은 판정 대상이 아니다 — 검수를 저장해도 서버가 400 으로 거부한다.
  if (run.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>실패한 런은 검수할 수 없습니다</AlertTitle>
        <AlertDescription>
          이 런은 오류로 끝나 판정 대상이 아닙니다 — 공고 카드의 &ldquo;저장된 런&rdquo;에서 성공
          런을 선택하거나 딥분석을 다시 실행해 주세요.
        </AlertDescription>
      </Alert>
    );
  }

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
      <ReviewGuide open={guideOpen} onOpenChange={setGuideOpen} />

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>기존 검수 로드 실패</AlertTitle>
          <AlertDescription className="break-words">
            {loadError} — 새로 작성해 저장하면 덮어씁니다.
          </AlertDescription>
        </Alert>
      ) : null}

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
        <FieldDescription>
          사람 검수자 본인의 이메일 — 이 검수가 골든셋의 1차 원천이 되므로 AI 라벨러
          식별자(prelabel·opus·claude 등)는 서버가 거부합니다.
        </FieldDescription>
      </Field>

      {/* 섹션 A — 제안 criterion 검수 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">① 제안 criterion 검수</span>
            <span className="text-xs text-muted-foreground">
              딥분석이 제안한 요건이 공고 원문에 실재하고 정확한지 하나씩 판정합니다 —
              정밀도·오류율 신호.
            </span>
          </div>
          <Badge variant={decidedA === run.criteria.length && run.criteria.length > 0 ? "default" : "secondary"} className="tabular-nums">
            {decidedA} / {run.criteria.length}
          </Badge>
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
              containerRef={registerItem(`c-${index}`)}
              onChange={(patch) => setCriterionDraft(index, patch)}
            />
          ))
        )}
      </div>

      {/* 섹션 B — 제안 없는 축 확인 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">② 제안 없는 축 확인</span>
            <span className="text-xs text-muted-foreground">
              딥분석 제안이 없는 축에 실제로도 요건이 없는지 확인합니다 — 재현율(누락) 신호.
            </span>
          </div>
          <Badge variant={decidedB === emptyAxes.length && emptyAxes.length > 0 ? "default" : "secondary"} className="tabular-nums">
            {decidedB} / {emptyAxes.length}
          </Badge>
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
              containerRef={registerItem(`a-${diff.dimension}`)}
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
          <AlertTitle>검수 저장 실패</AlertTitle>
          <AlertDescription className="break-words">{saveError}</AlertDescription>
        </Alert>
      ) : null}

      {/* 고정 저장 바 — 긴 시트를 스크롤해도 진행률·저장이 항상 보인다. */}
      <div className="sticky bottom-4 z-10 flex flex-col gap-2.5 rounded-xl border border-border bg-background/95 p-3 shadow-md backdrop-blur">
        <div className="flex items-center gap-3">
          <Progress value={total > 0 ? (decided / total) * 100 : 0} className="flex-1" />
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
              "검수 저장"
            )}
          </Button>
          {saveBlockedReason ? (
            <span className="text-xs text-destructive">{saveBlockedReason}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              부분 저장 가능 — 저장하면 이 런의 기존 검수를 덮어씁니다.
            </span>
          )}
          <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
            {dirty ? <Badge variant="secondary">미저장 변경</Badge> : null}
            {lastSavedAt ? `마지막 저장 ${formatDateTime(lastSavedAt)}` : "저장된 검수 없음"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 검수 안내 — 무엇을·어떤 기준으로 판정하고, 그 결과가 어떤 통과 기준을 결정하는지. */
function ReviewGuide({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const gates = ANALYSIS_LAB_GATES;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-xl border border-border bg-muted/20"
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" className="w-full justify-between px-4 py-3" />}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <CircleHelp data-icon="inline-start" />
          검수 안내 — 무엇을, 어떤 기준으로 판정하나요?
        </span>
        <ChevronDown data-icon="inline-end" className={cn("transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 border-t border-border px-4 py-4">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-semibold">① 제안 criterion 검수 (정밀도)</span>
            <p className="text-xs text-muted-foreground">
              딥분석이 제안한 요건 하나하나가 공고 원문에 실재하고 정확한지 판정합니다. 각
              항목의 <em className="not-italic font-medium">근거 인용</em>을 원문·첨부와
              대조하세요.
            </p>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-background p-3">
            <span className="text-xs font-semibold">② 제안 없는 축 확인 (재현율)</span>
            <p className="text-xs text-muted-foreground">
              딥분석이 아무 요건도 제안하지 않은 축에 정말 요건이 없는지 확인합니다. 원문에
              있는데 놓쳤다면 &ldquo;누락 있음&rdquo;으로 잡아주세요.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">판정 기준</span>
          {CRITERION_VERDICT_ORDER.map((verdict) => (
            <div key={verdict} className="flex items-start gap-2">
              <Badge variant={CRITERION_VERDICT_META[verdict].badge} className="mt-px shrink-0">
                {CRITERION_VERDICT_META[verdict].label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {CRITERION_VERDICT_META[verdict].hint}
              </span>
            </div>
          ))}
          {AXIS_VERDICT_ORDER.map((verdict) => (
            <div key={verdict} className="flex items-start gap-2">
              <Badge variant={AXIS_VERDICT_META[verdict].badge} className="mt-px shrink-0">
                {AXIS_VERDICT_META[verdict].label}
              </Badge>
              <span className="text-xs text-muted-foreground">{AXIS_VERDICT_META[verdict].hint}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">검수 요령</span>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p>
              · 판단 근거는 항상 <span className="font-medium text-foreground">공고 원문·첨부</span>입니다 —
              상단의 &ldquo;공고 원문&rdquo; 링크와 &ldquo;분석 문서&rdquo;·&ldquo;필드 채움&rdquo; 탭을 옆에 두고 대조하세요.
            </p>
            <p>
              · <Badge variant="destructive" className="align-middle">근거 미확인</Badge> 배지가 붙은 항목은
              인용문이 입력 원문에서 검증되지 않은 것 — 특히 의심해서 보세요.
            </p>
            <p>
              · 부분 저장이 가능하니 중간중간 저장하세요. 저장 전에 다른 런을 선택하거나 페이지를
              떠나면 판정이 사라집니다.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 rounded-lg border border-primary/25 bg-primary/5 p-3">
          <span className="text-xs font-semibold">
            이 검수가 결정하는 것 — 실험 통과 기준 {GATE_COUNT}종
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="tabular-nums">
              정확 비율 ≥ {Math.round(gates.strictPrecisionMin * 100)}%
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              오류 비율 ≤ {Math.round(gates.wrongRateMax * 100)}%
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              공고당 누락 ≤ {gates.missedPerNoticeMax}건
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              커버리지(정확 B ÷ 현행 A) ≥ {gates.coverageRatioMin}배
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              공고당 비용 ≤ ${gates.costPerNoticeMaxUsd}
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              구조화 비율(정확 확정 중 기계판정 가능) ≥ {Math.round(gates.structuredRatioMin * 100)}%
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            &ldquo;수정 필요&rdquo;·&ldquo;판단 불가&rdquo;도 정확 비율의 분모에 들어갑니다. 코호트 전 공고를
            검수·저장한 뒤 터미널에서{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">pnpm lab:aggregate</code>
            를 실행하면 🟢/🟡/🔴 종합 판정이 나옵니다.
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 섹션 A 카드 블럭 — 제안 criterion 1건 + 판정 ToggleGroup. */
function CriterionReviewBlock({
  index,
  criterion,
  label,
  draft,
  disabled,
  containerRef,
  onChange,
}: {
  index: number;
  criterion: LabCriterion;
  label: string;
  draft: CriterionDraft;
  disabled: boolean;
  containerRef: (element: HTMLElement | null) => void;
  onChange: (patch: Partial<CriterionDraft>) => void;
}) {
  return (
    <section
      ref={containerRef}
      className="min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-border"
    >
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
          {draft.verdict ? (
            <Badge variant={CRITERION_VERDICT_META[draft.verdict].badge}>
              {CRITERION_VERDICT_META[draft.verdict].label}
            </Badge>
          ) : (
            <Badge variant="ghost">미판정</Badge>
          )}
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
          {CRITERION_VERDICT_ORDER.map((verdict) => (
            <ToggleGroupItem key={verdict} value={verdict}>
              {CRITERION_VERDICT_META[verdict].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[11px] text-muted-foreground">
          {draft.verdict
            ? CRITERION_VERDICT_META[draft.verdict].hint
            : "이 요건이 공고 원문과 일치하는지 위 근거를 대조해 판정하세요."}
        </p>
        {draft.verdict && draft.verdict !== "correct" ? (
          <Textarea
            className="min-h-20"
            placeholder={CRITERION_NOTE_PLACEHOLDER[draft.verdict]}
            value={draft.note}
            maxLength={NOTE_MAX_CHARS}
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
  containerRef,
  onChange,
}: {
  diff: LabDimensionDiff;
  draft: AxisDraft;
  disabled: boolean;
  containerRef: (element: HTMLElement | null) => void;
  onChange: (patch: Partial<AxisDraft>) => void;
}) {
  const noteMissing = draft.verdict === "missed_condition" && draft.note.trim().length === 0;
  return (
    <section
      ref={containerRef}
      className="flex min-w-0 scroll-mt-24 flex-col gap-2 rounded-lg border border-border p-3"
    >
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
          {draft.verdict ? (
            <Badge variant={AXIS_VERDICT_META[draft.verdict].badge}>
              {AXIS_VERDICT_META[draft.verdict].label}
            </Badge>
          ) : (
            <Badge variant="ghost">미판정</Badge>
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
          {AXIS_VERDICT_ORDER.map((verdict) => (
            <ToggleGroupItem key={verdict} value={verdict}>
              {AXIS_VERDICT_META[verdict].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {draft.verdict ? (
        <p className="text-[11px] text-muted-foreground">{AXIS_VERDICT_META[draft.verdict].hint}</p>
      ) : null}
      {draft.verdict === "missed_condition" ? (
        <Textarea
          className="min-h-20"
          placeholder="원문 기준으로 누락된 요건 서술 (필수)"
          value={draft.note}
          maxLength={NOTE_MAX_CHARS}
          aria-invalid={noteMissing}
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

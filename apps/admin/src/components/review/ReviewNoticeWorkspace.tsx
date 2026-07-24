"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleIcon,
  EyeOffIcon,
  FileTextIcon,
  PencilLineIcon,
  SaveIcon,
} from "lucide-react"
import {
  HUMAN_REVIEW_AXIS_VERDICTS,
  HUMAN_REVIEW_CRITERION_VERDICTS,
  HUMAN_REVIEW_VERDICTS,
  humanReviewVerdictRequiresNote,
  type HumanReviewVerdict,
} from "@cunote/contracts"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  buildReviewItemPresentation,
  reviewDimensionLabel,
} from "@/lib/review/itemPresentation"
import type { ReviewNoticeItem } from "@/lib/server/review/dispatchReview"
import { cn } from "@/lib/utils"

type ReviewVerdict = HumanReviewVerdict

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  correct: "정확",
  needs_edit: "수정 필요",
  wrong: "오류",
  unsure: "판단 불가",
  confirmed_absent: "없음 확인",
  missed_condition: "누락 있음",
}

const CRITERION_VERDICTS = HUMAN_REVIEW_CRITERION_VERDICTS.map((value) => ({
  value,
  label: VERDICT_LABELS[value],
}))
const AXIS_VERDICTS = HUMAN_REVIEW_AXIS_VERDICTS.map((value) => ({
  value,
  label: VERDICT_LABELS[value],
}))

interface Draft {
  verdict: ReviewVerdict | null
  note: string
  revision: number
  dirty: boolean
  saved: boolean
}

export function ReviewNoticeWorkspace({
  noticeId,
  items,
  sourceReference,
}: {
  noticeId: string
  items: ReviewNoticeItem[]
  sourceReference: ReactNode
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(items.map((item) => [
      item.id,
      {
        verdict: isReviewVerdict(item.humanVerdict) ? item.humanVerdict : null,
        note: item.note ?? "",
        revision: item.revision,
        dirty: false,
        saved: isReviewVerdict(item.humanVerdict),
      },
    ])))
  const [activeItemId, setActiveItemId] = useState(
    () => items.find((item) => !isReviewVerdict(item.humanVerdict))?.id ?? items[0]?.id ?? "",
  )
  const [pending, startTransition] = useTransition()
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeItemId))
  const activeItem = items[activeIndex]
  const completedCount = useMemo(
    () => items.filter((item) => drafts[item.id]?.saved).length,
    [drafts, items],
  )
  const progress = items.length === 0
    ? 0
    : Math.round((completedCount / items.length) * 100)

  function updateDraft(itemId: string, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: {
        ...(current[itemId] ?? {
          verdict: null,
          note: "",
          revision: 0,
          dirty: false,
          saved: false,
        }),
        ...patch,
        dirty: true,
      },
    }))
  }

  function saveActive() {
    if (!activeItem) return
    const draft = drafts[activeItem.id]
    if (!draft?.verdict || (requiresNote(draft.verdict) && !draft.note.trim())) {
      toast.error("판정과 필수 사유를 확인해주세요.")
      return
    }
    startTransition(async () => {
      const response = await fetch(`/api/admin/review/notices/${noticeId}/verdicts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{
            itemId: activeItem.id,
            humanVerdict: draft.verdict,
            note: draft.note,
            revision: draft.revision,
          }],
        }),
      })
      const payload = await response.json() as {
        data?: { updated: Array<{ itemId: string; revision: number }> }
        error?: { message?: string }
      }
      if (!response.ok || !payload.data?.updated[0]) {
        toast.error(payload.error?.message ?? "판정을 저장하지 못했습니다.")
        return
      }

      const updated = payload.data.updated[0]
      const nextDrafts: Record<string, Draft> = {
        ...drafts,
        [activeItem.id]: {
          ...draft,
          revision: updated.revision,
          dirty: false,
          saved: true,
        },
      }
      setDrafts(nextDrafts)
      const nextItemId = nextUnfinishedItemId(items, nextDrafts, activeIndex)
      if (nextItemId) {
        setActiveItemId(nextItemId)
        toast.success("판정을 저장하고 다음 미판정 항목으로 이동했습니다.")
      } else {
        toast.success("이 공고의 모든 배정 항목을 판정했습니다.")
      }
    })
  }

  return (
    <main className="grid items-start gap-5 p-4 xl:grid-cols-[minmax(20rem,0.9fr)_minmax(30rem,1.25fr)_18rem] xl:p-6">
      {sourceReference}

      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">현재 검수 질문</h2>
            <p className="text-sm text-muted-foreground">
              원문 기준으로 한 항목씩 판정하면 저장 후 다음 미판정 항목이 자동으로 열립니다.
            </p>
          </div>
          <Badge variant="outline">
            {Math.min(activeIndex + 1, items.length)} / {items.length}
          </Badge>
        </div>

        {activeItem ? (
          <ReviewItemCard
            index={activeIndex}
            item={activeItem}
            draft={drafts[activeItem.id]!}
            disabled={pending}
            isLastUnfinished={
              items.filter((item) => !drafts[item.id]?.saved && item.id !== activeItem.id).length === 0
            }
            onChange={(patch) => updateDraft(activeItem.id, patch)}
            onSave={saveActive}
          />
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              이 공고에 배정된 검수 항목이 없습니다.
            </CardContent>
          </Card>
        )}
      </section>

      <FieldNavigator
        items={items}
        drafts={drafts}
        activeItemId={activeItemId}
        completedCount={completedCount}
        progress={progress}
        disabled={pending}
        onSelect={setActiveItemId}
      />
    </main>
  )
}

function ReviewItemCard({
  index,
  item,
  draft,
  disabled,
  isLastUnfinished,
  onChange,
  onSave,
}: {
  index: number
  item: ReviewNoticeItem
  draft: Draft
  disabled: boolean
  isLastUnfinished: boolean
  onChange: (patch: Partial<Draft>) => void
  onSave: () => void
}) {
  const presentation = buildReviewItemPresentation(item)
  const options = item.itemKind === "axis" ? AXIS_VERDICTS : CRITERION_VERDICTS
  const invalid = Boolean(draft.verdict && requiresNote(draft.verdict) && !draft.note.trim())
  const canSave = Boolean(draft.verdict) && (!draft.saved || draft.dirty)

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          #{index + 1} {presentation.title}
        </CardTitle>
        <CardDescription>
          영문 필드명: {item.dimension ?? item.itemKind}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center justify-end gap-2">
          <Badge variant="outline">{presentation.kindLabel}</Badge>
          {item.blind ? <Badge variant="outline">독립 표본</Badge> : null}
          <Badge variant={draft.dirty ? "outline" : draft.saved ? "secondary" : "outline"}>
            {draft.dirty ? "저장 전 변경" : draft.saved ? "저장 완료" : "미판정"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {item.blind ? (
          <Alert>
            <EyeOffIcon />
            <AlertTitle>독립 판정 표본</AlertTitle>
            <AlertDescription>
              편향을 막기 위해 AI의 기존 판정과 다른 검수자의 답은 표시하지 않습니다.
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="rounded-xl border bg-muted/40 p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">검수 질문</p>
          <p className="text-lg font-semibold leading-7">{presentation.question}</p>
          {presentation.extractedValue ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">AI가 추출한 값</span>
              <Badge variant="secondary">{presentation.extractedValue}</Badge>
            </div>
          ) : null}
        </section>

        {presentation.evidence ? (
          <section className="rounded-lg border-l-4 border-l-primary bg-muted p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">AI가 근거로 잡은 원문</p>
            <blockquote className="text-sm leading-6">“{presentation.evidence}”</blockquote>
          </section>
        ) : (
          <Alert>
            <FileTextIcon />
            <AlertTitle>원문 근거를 직접 찾아주세요</AlertTitle>
            <AlertDescription>
              확인된 인용 구간이 없습니다. 왼쪽 공고 원문이나 HWP/HWPX 첨부에서 실제 조건을 확인하세요.
            </AlertDescription>
          </Alert>
        )}

        {presentation.context.length ? (
          <dl className="grid gap-2 rounded-lg border p-3 text-sm">
            {presentation.context.map((entry, contextIndex) => (
              <div key={`${entry.label}-${contextIndex}`} className="grid gap-1 sm:grid-cols-[9rem_1fr]">
                <dt className="text-muted-foreground">{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <FieldGroup className="rounded-xl border-2 border-primary/25 bg-primary/5 p-4 shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary p-2 text-primary-foreground">
              <PencilLineIcon className="size-4" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="font-semibold">검수자 입력</p>
              <p className="text-sm text-muted-foreground">
                원문을 기준으로 판정을 선택하고, 필요한 경우 수정 근거를 적어주세요.
              </p>
            </div>
          </div>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel className="text-base">1. 원문 기준 판정</FieldLabel>
            <ToggleGroup
              variant="outline"
              size="sm"
              value={draft.verdict ? [draft.verdict] : []}
              onValueChange={(values) => {
                const verdict = (values.at(-1) as ReviewVerdict | undefined) ?? null
                onChange({ verdict })
              }}
              disabled={disabled}
              aria-label={`항목 ${index + 1} 판정`}
            >
              {options.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              {draft.saved
                ? "이미 저장된 판정입니다. 수정이 필요할 때만 값을 바꿔 다시 저장하세요."
                : item.itemKind === "axis"
                  ? "조건이 실제로 없으면 ‘없음 확인’, 있는데 분석에서 빠졌다면 ‘누락 있음’을 선택하세요."
                  : "AI 분석과 원문이 같으면 ‘정확’, 값이나 조건이 다르면 수정 필요·오류를 선택하세요."}
            </FieldDescription>
          </Field>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel className="text-base" htmlFor={`note-${item.id}`}>
              2. 판정 사유 {draft.verdict && requiresNote(draft.verdict) ? "(필수)" : "(선택)"}
            </FieldLabel>
            <Textarea
              id={`note-${item.id}`}
              value={draft.note}
              onChange={(event) => onChange({ note: event.target.value })}
              placeholder="예: 원문은 ‘소상공인’만 요구하며 모든 소기업을 포함하지 않습니다. 올바른 값은 소상공인입니다."
              maxLength={4_000}
              className="min-h-28 bg-background"
              disabled={disabled}
              aria-invalid={invalid}
            />
            {invalid ? <FieldError>이 판정에는 원문 근거와 수정 방향을 적어야 합니다.</FieldError> : null}
          </Field>
        </FieldGroup>

        <details className="rounded-lg border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">기술 정보 보기</summary>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-5">
            {JSON.stringify(item.payload, null, 2)}
          </pre>
        </details>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-3 border-t">
        <span className="text-sm text-muted-foreground">
          {draft.dirty ? "변경 내용이 아직 저장되지 않았습니다." : draft.saved ? "이 판정은 저장되었습니다." : "판정을 선택한 뒤 저장하세요."}
        </span>
        <Button onClick={onSave} disabled={disabled || !canSave || invalid}>
          {disabled ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
          {draft.saved && !draft.dirty
            ? "저장된 판정"
            : isLastUnfinished
              ? "저장하고 공고 검수 완료"
              : "저장하고 다음 미판정 항목"}
          {!disabled && canSave ? <ArrowRightIcon data-icon="inline-end" /> : null}
        </Button>
      </CardFooter>
    </Card>
  )
}

function FieldNavigator({
  items,
  drafts,
  activeItemId,
  completedCount,
  progress,
  disabled,
  onSelect,
}: {
  items: ReviewNoticeItem[]
  drafts: Record<string, Draft>
  activeItemId: string
  completedCount: number
  progress: number
  disabled: boolean
  onSelect: (itemId: string) => void
}) {
  const reviewComplete = items.length > 0 && completedCount === items.length

  return (
    <aside className="min-w-0 xl:sticky xl:top-6">
      <Card size="sm">
        <CardHeader>
          <CardTitle>전체 필드</CardTitle>
          <CardDescription>
            {completedCount}/{items.length}개 저장 완료
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Progress
              value={progress}
              className="min-w-0 flex-1"
              aria-label="공고 검수 진행률"
            />
            <span className="shrink-0 text-sm font-medium tabular-nums">{progress}%</span>
          </div>
          <nav className="flex max-h-[calc(100vh-14rem)] flex-col gap-1 overflow-auto" aria-label="검수 필드 목록">
            {items.map((item, index) => {
              const draft = drafts[item.id]
              const active = item.id === activeItemId
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  className="h-auto min-h-11 justify-start gap-2 px-2 py-2 text-left"
                  onClick={() => onSelect(item.id)}
                  disabled={disabled}
                  aria-current={active ? "step" : undefined}
                >
                  {draft?.saved && !draft.dirty ? (
                    <CheckCircle2Icon className="shrink-0 text-primary" />
                  ) : (
                    <CircleIcon className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">
                      #{index + 1} {reviewDimensionLabel(item.dimension)}
                    </span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {draft?.dirty
                        ? "저장 전 변경"
                        : draft?.saved && draft.verdict
                          ? VERDICT_LABELS[draft.verdict]
                          : "미판정"}
                    </span>
                  </span>
                </Button>
              )
            })}
          </nav>
        </CardContent>
        {reviewComplete ? (
          <CardFooter className="flex-col items-stretch gap-3 border-t">
            <p className="text-sm font-medium">이 공고의 전체 검수가 완료되었습니다.</p>
            <Link
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
              href="/review"
            >
              <ArrowLeftIcon data-icon="inline-start" />
              공고 목록으로 돌아가기
            </Link>
          </CardFooter>
        ) : null}
      </Card>
    </aside>
  )
}

function nextUnfinishedItemId(
  items: ReviewNoticeItem[],
  drafts: Record<string, Draft>,
  currentIndex: number,
): string | null {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const item = items[(currentIndex + offset) % items.length]
    if (item && !drafts[item.id]?.saved) return item.id
  }
  return null
}

function requiresNote(verdict: ReviewVerdict): boolean {
  return humanReviewVerdictRequiresNote(verdict)
}

function isReviewVerdict(value: string | null): value is ReviewVerdict {
  return (HUMAN_REVIEW_VERDICTS as readonly string[]).includes(value ?? "")
}

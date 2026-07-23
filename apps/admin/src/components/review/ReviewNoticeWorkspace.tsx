"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { EyeOffIcon, SaveIcon } from "lucide-react"
import {
  HUMAN_REVIEW_AXIS_VERDICTS,
  HUMAN_REVIEW_CRITERION_VERDICTS,
  HUMAN_REVIEW_VERDICTS,
  humanReviewVerdictRequiresNote,
  type HumanReviewVerdict,
} from "@cunote/contracts"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type {
  ReviewNoticeDetail,
  ReviewNoticeItem,
} from "@/lib/server/review/dispatchReview"
import { SafeMarkdown } from "./SafeMarkdown"

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
}

export function ReviewNoticeWorkspace({ notice }: { notice: ReviewNoticeDetail }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(notice.items.map((item) => [
      item.id,
      {
        verdict: isReviewVerdict(item.humanVerdict) ? item.humanVerdict : null,
        note: item.note ?? "",
        revision: item.revision,
        dirty: false,
      },
    ])))
  const [pending, startTransition] = useTransition()
  const dirtyItems = useMemo(
    () => notice.items.filter((item) => drafts[item.id]?.dirty),
    [drafts, notice.items],
  )

  function updateDraft(itemId: string, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: {
        ...(current[itemId] ?? { verdict: null, note: "", revision: 0, dirty: false }),
        ...patch,
        dirty: true,
      },
    }))
  }

  function save() {
    const invalid = dirtyItems.find((item) => {
      const draft = drafts[item.id]
      return !draft?.verdict || (requiresNote(draft.verdict) && !draft.note.trim())
    })
    if (invalid) {
      toast.error("판정과 필수 사유를 확인해주세요.")
      return
    }
    startTransition(async () => {
      const response = await fetch(`/api/admin/review/notices/${notice.id}/verdicts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: dirtyItems.map((item) => ({
            itemId: item.id,
            humanVerdict: drafts[item.id]!.verdict,
            note: drafts[item.id]!.note,
            revision: drafts[item.id]!.revision,
          })),
        }),
      })
      const payload = await response.json() as {
        data?: { updated: Array<{ itemId: string; revision: number }> }
        error?: { message?: string }
      }
      if (!response.ok || !payload.data) {
        toast.error(payload.error?.message ?? "판정을 저장하지 못했습니다.")
        return
      }
      setDrafts((current) => {
        const next = { ...current }
        for (const item of payload.data!.updated) {
          const draft = next[item.itemId]
          if (draft) next[item.itemId] = { ...draft, revision: item.revision, dirty: false }
        }
        return next
      })
      toast.success(`${payload.data.updated.length}개 판정을 저장했습니다.`)
    })
  }

  return (
    <main className="grid gap-6 p-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(24rem,0.95fr)] lg:p-6">
      <Card className="min-w-0 self-start">
        <CardHeader>
          <CardTitle>판정 근거</CardTitle>
          <CardDescription>
            원문과 분석 문서를 나란히 확인하고, DB에 그대로 넣었을 때 결론이 달라지는지 판단합니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="source">
            <TabsList>
              <TabsTrigger value="source">공고 원문</TabsTrigger>
              <TabsTrigger value="analysis">분석 문서</TabsTrigger>
            </TabsList>
            <TabsContent value="source">
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs leading-6">
                {notice.inputText || "저장된 원문이 없습니다."}
              </pre>
            </TabsContent>
            <TabsContent value="analysis">
              <div className="max-h-[70vh] overflow-auto rounded-lg bg-muted p-4">
                <SafeMarkdown>{notice.analysisMarkdown || "저장된 분석 문서가 없습니다."}</SafeMarkdown>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">배정 항목 {notice.items.length}개</h2>
            <p className="text-sm text-muted-foreground">정확 외 판정에는 원문 근거와 수정 방향을 남겨주세요.</p>
          </div>
          <Button onClick={save} disabled={pending || dirtyItems.length === 0}>
            {pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            변경 {dirtyItems.length}개 저장
          </Button>
        </div>

        {notice.items.map((item, index) => (
          <ReviewItemCard
            key={item.id}
            index={index}
            item={item}
            draft={drafts[item.id]!}
            disabled={pending}
            onChange={(patch) => updateDraft(item.id, patch)}
          />
        ))}
      </section>
    </main>
  )
}

function ReviewItemCard({
  index,
  item,
  draft,
  disabled,
  onChange,
}: {
  index: number
  item: ReviewNoticeItem
  draft: Draft
  disabled: boolean
  onChange: (patch: Partial<Draft>) => void
}) {
  const options = item.itemKind === "axis" ? AXIS_VERDICTS : CRITERION_VERDICTS
  const invalid = Boolean(draft.verdict && requiresNote(draft.verdict) && !draft.note.trim())
  return (
    <Card size="sm" className="[content-visibility:auto]">
      <CardHeader>
        <CardTitle>
          #{index + 1} {item.dimension ?? item.itemKind}
        </CardTitle>
        <CardDescription>
          {item.itemKind} · {item.collectTarget === "audit_file" ? "감사 파일 수거" : "확장 overlay 수거"}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {item.blind ? <Badge variant="outline">blind</Badge> : null}
          <Badge variant={item.status === "conflict" ? "destructive" : "secondary"}>{item.status}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {item.blind ? (
          <Alert>
            <EyeOffIcon />
            <AlertTitle>독립 판정 표본</AlertTitle>
            <AlertDescription>AI 판정과 다른 검수자의 답은 서버 응답에서 제거됐습니다.</AlertDescription>
          </Alert>
        ) : null}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-5">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
        <FieldGroup>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel>판정</FieldLabel>
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
            <FieldDescription>판정은 언제든 revision 충돌 없이 최신 상태에서 다시 수정할 수 있습니다.</FieldDescription>
          </Field>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={`note-${item.id}`}>
              판정 사유 {draft.verdict && requiresNote(draft.verdict) ? "(필수)" : "(선택)"}
            </FieldLabel>
            <Textarea
              id={`note-${item.id}`}
              value={draft.note}
              onChange={(event) => onChange({ note: event.target.value })}
              placeholder="무엇이 틀렸고 올바른 값은 무엇인지 원문 기준으로 적어주세요."
              maxLength={4_000}
              disabled={disabled}
              aria-invalid={invalid}
            />
            {invalid ? <FieldError>이 판정에는 사유가 필요합니다.</FieldError> : null}
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-between text-xs text-muted-foreground">
        <span>revision {draft.revision}</span>
        <span>{draft.dirty ? "저장 전 변경" : item.updatedAt}</span>
      </CardFooter>
    </Card>
  )
}

function requiresNote(verdict: ReviewVerdict): boolean {
  return humanReviewVerdictRequiresNote(verdict)
}

function isReviewVerdict(value: string | null): value is ReviewVerdict {
  return (HUMAN_REVIEW_VERDICTS as readonly string[]).includes(value ?? "")
}

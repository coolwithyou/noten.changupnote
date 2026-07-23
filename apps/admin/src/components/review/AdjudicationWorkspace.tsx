"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { GavelIcon } from "lucide-react"
import {
  HUMAN_REVIEW_AXIS_VERDICTS,
  HUMAN_REVIEW_CRITERION_VERDICTS,
  type HumanReviewVerdict,
} from "@cunote/contracts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type {
  AdjudicationItem,
} from "@/lib/server/review/dispatchReview"

type ReviewVerdict = HumanReviewVerdict
const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  correct: "정확",
  needs_edit: "수정 필요",
  wrong: "오류",
  unsure: "판단 불가",
  confirmed_absent: "없음 확인",
  missed_condition: "누락 있음",
}

export function AdjudicationWorkspace({ initialItems }: { initialItems: AdjudicationItem[] }) {
  const [items, setItems] = useState(initialItems)
  const [pending, startTransition] = useTransition()
  const [drafts, setDrafts] = useState<Record<string, { verdict: ReviewVerdict | null; note: string }>>({})

  function resolve(item: AdjudicationItem) {
    const draft = drafts[item.overlapGroup]
    if (!draft?.verdict || !draft.note.trim()) {
      toast.error("최종 판정과 3심 사유를 입력해주세요.")
      return
    }
    startTransition(async () => {
      const response = await fetch(`/api/admin/review/adjudicate/${item.decisions[0]?.itemId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finalVerdict: draft.verdict, note: draft.note }),
      })
      const payload = await response.json() as { data?: unknown; error?: { message?: string } }
      if (!response.ok || !payload.data) {
        toast.error(payload.error?.message ?? "3심 판정을 저장하지 못했습니다.")
        return
      }
      setItems((current) => current.filter((entry) => entry.overlapGroup !== item.overlapGroup))
      toast.success("충돌 항목의 최종 판정을 저장했습니다.")
    })
  }

  if (items.length === 0) {
    return <p className="rounded-lg border p-6 text-sm text-muted-foreground">현재 3심 대기 항목이 없습니다.</p>
  }

  return (
    <section className="flex flex-col gap-4">
      {items.map((item) => {
        const draft = drafts[item.overlapGroup] ?? { verdict: null, note: "" }
        const verdicts =
          item.itemKind === "axis" ? HUMAN_REVIEW_AXIS_VERDICTS : HUMAN_REVIEW_CRITERION_VERDICTS
        return (
          <Card key={item.overlapGroup}>
            <CardHeader>
              <CardTitle>{item.noticeTitle}</CardTitle>
              <CardDescription>{item.dimension ?? item.itemKind} · {item.sourceItemKey}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                {item.decisions.map((decision) => (
                  <Card key={decision.itemId} size="sm">
                    <CardHeader>
                      <CardTitle>{decision.assigneeEmail}</CardTitle>
                      <CardDescription><Badge variant="outline">{decision.humanVerdict}</Badge></CardDescription>
                    </CardHeader>
                    <CardContent className="whitespace-pre-wrap text-sm">
                      {decision.note || "사유 없음"}
                    </CardContent>
                  </Card>
                ))}
              </div>
              <FieldGroup>
                <Field>
                  <FieldLabel>최종 판정</FieldLabel>
                  <ToggleGroup
                    variant="outline"
                    size="sm"
                    value={draft.verdict ? [draft.verdict] : []}
                    onValueChange={(values) => setDrafts((current) => ({
                      ...current,
                      [item.overlapGroup]: {
                        ...draft,
                        verdict: (values.at(-1) as ReviewVerdict | undefined) ?? null,
                      },
                    }))}
                    disabled={pending}
                  >
                    {verdicts.map((verdict) => (
                      <ToggleGroupItem key={verdict} value={verdict}>{VERDICT_LABELS[verdict]}</ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`adjudication-${item.overlapGroup}`}>3심 사유 (필수)</FieldLabel>
                  <Textarea
                    id={`adjudication-${item.overlapGroup}`}
                    value={draft.note}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [item.overlapGroup]: { ...draft, note: event.target.value },
                    }))}
                    maxLength={4_000}
                    disabled={pending}
                  />
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-end">
              <Button onClick={() => resolve(item)} disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : <GavelIcon data-icon="inline-start" />}
                최종 판정 저장
              </Button>
            </CardFooter>
          </Card>
        )
      })}
    </section>
  )
}

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  beginLegacyQuestionMigrationReviewImport,
  buildLegacyQuestionMigrationReviewDecisionSet,
  importLegacyQuestionMigrationReviewFiles,
  legacyQuestionMigrationDecisionSetFilename,
  legacyQuestionMigrationReviewProgressStorageKey,
  restoreLegacyQuestionMigrationReviewProgress,
  serializeLegacyQuestionMigrationReviewProgress,
  type EditableLegacyQuestionMigrationReviewItem,
  type ImportedLegacyQuestionMigrationReview,
  type LegacyQuestionMigrationEditorVerdict,
} from "@/lib/legacy-question-migration-review"

const VERDICT_LABELS = {
  approve_for_v2_draft: "v2 초안 승인",
  repair_criterion: "조건 구조 수리",
  retire_legacy_question: "기존 질문 폐기",
} as const

export function LegacyQuestionMigrationReviewEditor({ actorEmail }: { actorEmail: string }) {
  const [review, setReview] = useState<ImportedLegacyQuestionMigrationReview | null>(null)
  const [reviewerEmail, setReviewerEmail] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const importGeneration = useRef(0)
  const reviewedCount = useMemo(
    () => review?.items.filter((item) => item.verdict !== "pending").length ?? 0,
    [review],
  )
  const activeItem = review?.items[activeIndex]

  async function importFiles(fileList: FileList | null) {
    if (!fileList?.length) return
    const generation = beginLegacyQuestionMigrationReviewImport(importGeneration)
    setIsImporting(true)
    setError(null)
    try {
      const files = await Promise.all([...fileList].map(async (file) => ({
        name: file.name,
        text: await file.text(),
      })))
      const imported = await importLegacyQuestionMigrationReviewFiles(files)
      if (!generation.isLatest()) return
      const storageKey = legacyQuestionMigrationReviewProgressStorageKey(imported.manifest)
      const saved = window.localStorage.getItem(storageKey)
      if (saved) {
        try {
          const restored = restoreLegacyQuestionMigrationReviewProgress({ review: imported, raw: saved })
          setReview(restored.review)
          setReviewerEmail(restored.reviewerEmail)
          setActiveIndex(restored.activeIndex)
        } catch {
          window.localStorage.removeItem(storageKey)
          setReview(imported)
          setReviewerEmail("")
          setActiveIndex(0)
        }
      } else {
        setReview(imported)
        setReviewerEmail("")
        setActiveIndex(0)
      }
    } catch (cause) {
      if (!generation.isLatest()) return
      setReview(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation.isLatest()) setIsImporting(false)
    }
  }

  useEffect(() => {
    if (!review || isImporting) return
    window.localStorage.setItem(
      legacyQuestionMigrationReviewProgressStorageKey(review.manifest),
      serializeLegacyQuestionMigrationReviewProgress({ review, reviewerEmail, activeIndex }),
    )
  }, [activeIndex, isImporting, review, reviewerEmail])

  function updateActive(
    update: (item: EditableLegacyQuestionMigrationReviewItem) => EditableLegacyQuestionMigrationReviewItem,
  ) {
    setReview((current) => current ? {
      ...current,
      items: current.items.map((item, index) => index === activeIndex ? update(item) : item),
    } : current)
  }

  async function downloadDecisionSet() {
    if (!review || isImporting) return
    setError(null)
    try {
      const decisionSet = await buildLegacyQuestionMigrationReviewDecisionSet({
        manifest: review.manifest,
        reviewerEmail,
        reviewedAt: new Date().toISOString(),
        items: review.items,
      })
      const blob = new Blob([`${JSON.stringify(decisionSet, null, 2)}\n`], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = legacyQuestionMigrationDecisionSetFilename(review.manifest)
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function moveToNextPending() {
    if (!review) return
    const next = review.items.findIndex((item, index) => index > activeIndex && item.verdict === "pending")
    const wrapped = review.items.findIndex((item) => item.verdict === "pending")
    setActiveIndex(next >= 0 ? next : wrapped >= 0 ? wrapped : activeIndex)
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>사람 검수 결정을 기록하는 로컬 도구입니다</AlertTitle>
        <AlertDescription>
          manifest와 모든 packet을 브라우저 안에서 검증하고 결정 파일만 내려받습니다. 서비스 DB, 기존 질문, v2 초안, release에는 아무 변경도 하지 않습니다.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>1. 검수 묶음 가져오기</CardTitle>
          <CardDescription>하나의 manifest와 manifest에 적힌 packet JSON 전부를 함께 선택하세요.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="migration-review-files">Manifest와 packet JSON</FieldLabel>
              <Input
                id="migration-review-files"
                type="file"
                accept="application/json,.json"
                multiple
                disabled={isImporting}
                onChange={(event) => void importFiles(event.currentTarget.files)}
              />
              <FieldDescription>
                파일은 서버로 전송되지 않습니다. 누락·추가 파일, snapshot 혼합, 내용 SHA 불일치는 즉시 거부합니다.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>계속할 수 없습니다</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {review && activeItem ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>검수 진행</CardTitle>
              <CardDescription>
                Shadow {shortHash(review.manifest.shadow.snapshotSha256)} · manifest {shortHash(review.manifest.contentSha256)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={(reviewedCount / review.items.length) * 100}>
                <ProgressLabel>명시 판정</ProgressLabel>
                <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                  {reviewedCount}/{review.items.length}
                </span>
              </Progress>
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              <Badge variant="outline">대기 {review.items.length - reviewedCount}</Badge>
              <Badge variant="secondary">승인 {countVerdict(review.items, "approve_for_v2_draft")}</Badge>
              <Badge variant="outline">수리 {countVerdict(review.items, "repair_criterion")}</Badge>
              <Badge variant="outline">폐기 {countVerdict(review.items, "retire_legacy_question")}</Badge>
            </CardFooter>
          </Card>

          <ReviewCard
            item={activeItem}
            index={activeIndex}
            total={review.items.length}
            onChange={updateActive}
            onPrevious={() => setActiveIndex((current) => Math.max(0, current - 1))}
            onNext={() => setActiveIndex((current) => Math.min(review.items.length - 1, current + 1))}
            onNextPending={moveToNextPending}
          />

          <Card>
            <CardHeader>
              <CardTitle>3. 결속된 결정 세트 내보내기</CardTitle>
              <CardDescription>
                {review.items.length}건 모두를 판정해야 합니다. 진행 상태는 이 브라우저에 manifest별로 자동 저장됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="migration-review-actor">현재 로그인 actor</FieldLabel>
                  <Input id="migration-review-actor" value={actorEmail} readOnly aria-readonly="true" />
                  <FieldDescription>화면 접근 주체이며 실제 검수자 증명으로 자동 사용하지 않습니다.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="migration-reviewer-email">실제 사람 검수자 이메일</FieldLabel>
                  <Input
                    id="migration-reviewer-email"
                    type="email"
                    autoComplete="off"
                    placeholder="human-reviewer@example.com"
                    value={reviewerEmail}
                    onChange={(event) => setReviewerEmail(event.currentTarget.value)}
                  />
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-end">
              <Button type="button" onClick={() => void downloadDecisionSet()} disabled={isImporting || reviewedCount !== review.items.length}>
                <DownloadIcon data-icon="inline-start" />
                쓰기 권한 없는 결정 파일 내려받기
              </Button>
            </CardFooter>
          </Card>
        </>
      ) : null}
    </div>
  )
}

function ReviewCard({
  item,
  index,
  total,
  onChange,
  onPrevious,
  onNext,
  onNextPending,
}: {
  item: EditableLegacyQuestionMigrationReviewItem
  index: number
  total: number
  onChange: (update: (item: EditableLegacyQuestionMigrationReviewItem) => EditableLegacyQuestionMigrationReviewItem) => void
  onPrevious: () => void
  onNext: () => void
  onNextPending: () => void
}) {
  const packet = item.packet
  function selectVerdict(verdict: LegacyQuestionMigrationEditorVerdict) {
    onChange((current) => ({
      ...current,
      verdict,
      polarityConfirmed: verdict === "approve_for_v2_draft" ? current.polarityConfirmed : false,
      resolutionScope: verdict === "approve_for_v2_draft" ? current.resolutionScope : null,
    }))
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{index + 1}/{total}</Badge>
          <Badge variant="outline">{packet.criterion.kind}</Badge>
          <Badge variant="outline">{packet.criterion.dimension}</Badge>
          {packet.legacyQuestion.answerCount > 0 ? <Badge variant="secondary">기존 답변 있음</Badge> : null}
        </div>
        <CardTitle className="text-lg">{packet.grant.title}</CardTitle>
        <CardDescription>{packet.grant.source} · {packet.grant.sourceId}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">현재 원문의 조건</h3>
          <blockquote className="rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed">
            {packet.criterion.sourceSpan}
          </blockquote>
          {packet.grant.url ? (
            <a className="inline-flex w-fit items-center gap-1 text-sm font-medium underline underline-offset-4" href={packet.grant.url} target="_blank" rel="noreferrer">
              공고 원문 열기 <ExternalLinkIcon data-icon="inline-end" />
            </a>
          ) : null}
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <Evidence label="기존 질문" value={packet.legacyQuestion.prompt} />
          <Evidence label="기존 선택지" value={packet.legacyQuestion.options.map(optionSummary).join("\n")} />
          <Evidence label="예상 평가 극성" value={polarityLabel(packet.requiredReview.expectedPolarity)} />
          <Evidence label="기존 재사용 표기" value={`${packet.legacyQuestion.reusable} · 답변 ${packet.legacyQuestion.answerCount}건 / 회사 ${packet.legacyQuestion.answeringCompanyCount}곳`} />
        </section>

        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>검수할 네 가지</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {packet.requiredReview.checks.map((check) => <li key={check}>{check}</li>)}
            </ul>
          </AlertDescription>
        </Alert>

        <FieldGroup>
          <Field>
            <FieldLabel>2. 이 기존 질문을 어떻게 처리할까요?</FieldLabel>
            <ToggleGroup
              variant="outline"
              value={item.verdict === "pending" ? [] : [item.verdict]}
              onValueChange={(values) => selectVerdict((values.at(-1) as LegacyQuestionMigrationEditorVerdict | undefined) ?? "pending")}
              className="flex-wrap"
            >
              {Object.entries(VERDICT_LABELS).map(([value, label]) => (
                <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>승인은 현재 질문을 그대로 공개한다는 뜻이 아니라, 기존 v2 질문 초안 단계로 보낼 수 있다는 뜻입니다.</FieldDescription>
          </Field>

          {item.verdict === "approve_for_v2_draft" ? (
            <>
              <Field orientation="horizontal">
                <Checkbox
                  id={`polarity-${packet.legacyQuestion.id}`}
                  checked={item.polarityConfirmed}
                  onCheckedChange={(checked) => onChange((current) => ({ ...current, polarityConfirmed: Boolean(checked) }))}
                />
                <FieldLabel htmlFor={`polarity-${packet.legacyQuestion.id}`}>
                  {polarityLabel(packet.requiredReview.expectedPolarity)} 극성이 원문 조건과 일치함을 확인했습니다.
                </FieldLabel>
              </Field>
              <Field>
                <FieldLabel>답변 해소 범위</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  value={item.resolutionScope ? [item.resolutionScope] : []}
                  onValueChange={(values) => onChange((current) => ({
                    ...current,
                    resolutionScope: values.at(-1) === "company_fact" ? "company_fact" : values.at(-1) === "per_notice" ? "per_notice" : null,
                  }))}
                >
                  <ToggleGroupItem value="company_fact">회사 사실 · 관련 공고 재사용</ToggleGroupItem>
                  <ToggleGroupItem value="per_notice">이 공고에서만 사용</ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription>기존 reusable 값은 참고 자료일 뿐이며, 여기서 사람이 다시 확정해야 합니다.</FieldDescription>
              </Field>
            </>
          ) : null}

          <Field>
            <FieldLabel htmlFor={`review-note-${packet.legacyQuestion.id}`}>검수 메모 {item.verdict === "approve_for_v2_draft" ? "" : "(수리·폐기는 필수)"}</FieldLabel>
            <Textarea
              id={`review-note-${packet.legacyQuestion.id}`}
              value={item.note}
              maxLength={4_000}
              placeholder="판정 근거나 필요한 수리 내용을 기록하세요."
              onChange={(event) => {
                const note = event.currentTarget.value
                onChange((current) => ({ ...current, note }))
              }}
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" onClick={onPrevious} disabled={index === 0}>
          <ArrowLeftIcon data-icon="inline-start" /> 이전
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onNextPending}>다음 미검수</Button>
          <Button type="button" onClick={onNext} disabled={index === total - 1}>
            다음 <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

function Evidence({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{value}</p>
    </div>
  )
}

function optionSummary(option: Record<string, unknown>): string {
  const value = typeof option.value === "string" ? option.value : null
  const label = typeof option.label === "string" ? option.label : null
  const evaluation = typeof option.evaluation === "string" ? option.evaluation : null
  return [value, label, evaluation].filter(Boolean).join(" · ") || JSON.stringify(option)
}

function polarityLabel(value: "criterion_satisfaction" | "exclusion_membership"): string {
  return value === "exclusion_membership" ? "제외 조건 해당 여부" : "자격 조건 충족 여부"
}

function countVerdict(
  items: readonly EditableLegacyQuestionMigrationReviewItem[],
  verdict: Exclude<LegacyQuestionMigrationEditorVerdict, "pending">,
): number {
  return items.filter((item) => item.verdict === verdict).length
}

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

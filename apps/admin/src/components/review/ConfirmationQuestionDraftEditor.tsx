"use client"

import { useMemo, useRef, useState } from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ShieldAlertIcon,
  XCircleIcon,
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  beginConfirmationQuestionDraftImport,
  buildManualConfirmationDraftInput,
  importConfirmationQuestionDraft,
  manualConfirmationDraftFilename,
  type EditableConfirmationQuestionDraftItem,
  type ImportedConfirmationQuestionDraft,
} from "@/lib/confirmation-question-draft"

export function ConfirmationQuestionDraftEditor({ actorEmail }: { actorEmail: string }) {
  const [draft, setDraft] = useState<ImportedConfirmationQuestionDraft | null>(null)
  const [questionAuthorEmail, setQuestionAuthorEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const importGeneration = useRef(0)
  const importInProgress = useRef(false)
  const reviewedCount = useMemo(
    () => draft?.items.filter((item) => item.decision !== "pending").length ?? 0,
    [draft],
  )

  async function importFile(file: File | undefined) {
    if (!file) return
    const generation = beginConfirmationQuestionDraftImport(importGeneration)
    importInProgress.current = true
    setIsImporting(true)
    setError(null)
    try {
      const imported = await importConfirmationQuestionDraft(await file.text())
      if (!generation.isLatest()) return
      setDraft(imported)
      setQuestionAuthorEmail(imported.questionAuthorEmail)
    } catch (cause) {
      if (!generation.isLatest()) return
      setDraft(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation.isLatest()) {
        importInProgress.current = false
        setIsImporting(false)
      }
    }
  }

  function updateItem(
    criterionIndex: number,
    update: (item: EditableConfirmationQuestionDraftItem) => EditableConfirmationQuestionDraftItem,
  ) {
    setDraft((current) => current ? {
      ...current,
      items: current.items.map((item) => item.criterionIndex === criterionIndex ? update(item) : item),
    } : current)
  }

  function downloadManualInput() {
    if (!draft || importInProgress.current) return
    setError(null)
    try {
      const manualInput = buildManualConfirmationDraftInput({
        packet: draft.packet,
        questionAuthorEmail,
        items: draft.items,
      })
      const blob = new Blob([`${JSON.stringify(manualInput, null, 2)}\n`], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = manualConfirmationDraftFilename(draft.packet)
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <ShieldAlertIcon />
        <AlertTitle>이 화면은 로컬 파일 편집기입니다</AlertTitle>
        <AlertDescription>
          packet을 브라우저에서만 읽고 manual CLI 입력 파일을 내려받습니다. 서비스 DB·실제 질문·release·selector는 변경하지 않습니다.
          기존 manual CLI는 원 run/review 파일 SHA와 packet 결속을 재검증합니다. 현재 서비스 source revision·상태 재대조는 이 화면과 manual CLI가 하지 않으며 후속 release/promotion 경계의 책임입니다.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>1. 불변 draft packet 가져오기</CardTitle>
          <CardDescription>
            offline generator가 만든 content-addressed JSON만 허용하며, packet content SHA를 브라우저에서 다시 계산합니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="confirmation-draft-file">Draft packet JSON</FieldLabel>
              <Input
                id="confirmation-draft-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importFile(event.currentTarget.files?.[0])}
              />
              <FieldDescription>
                파일은 서버에 업로드되지 않습니다. 내보낸 bound 파일을 다시 가져오면 편집·검토 상태를 이어갈 수 있습니다.
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

      {draft ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Packet 결속</CardTitle>
              <CardDescription>가져온 파일의 진단용 결속이며 current 서비스 검증을 뜻하지 않습니다.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Binding label="Grant / run" value={`${draft.packet.source.grantId}\n${draft.packet.source.runId}`} />
              <Binding label="Source" value={`${draft.packet.source.source} / ${draft.packet.source.sourceId}`} />
              <Binding label="Packet content SHA" value={draft.packet.contentSha256} />
              <Binding label="가져온 file SHA" value={draft.fileSha256} />
              <Binding label="Run artifact SHA" value={draft.packet.source.runArtifactSha256} />
              <Binding label="Review artifact SHA" value={draft.packet.source.reviewArtifactSha256} />
              <Binding label="Source revision SHA" value={draft.packet.source.sourceRevisionSha256} />
              <Binding label="Criterion 검수자" value={draft.packet.source.criterionReviewerEmail} />
            </CardContent>
            <CardFooter className="justify-between gap-3">
              <span className="text-sm text-muted-foreground">후보 검토 {reviewedCount}/{draft.items.length}</span>
              <Badge variant={reviewedCount === draft.items.length ? "secondary" : "outline"}>
                {reviewedCount === draft.items.length ? "명시 검토 완료" : "검토 필요"}
              </Badge>
            </CardFooter>
          </Card>

          <div className="flex flex-col gap-4">
            {draft.items.map((item) => (
              <QuestionCard
                key={item.criterionIndex}
                item={item}
                onChange={(update) => updateItem(item.criterionIndex, update)}
              />
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>3. 기존 manual CLI 입력 내보내기</CardTitle>
              <CardDescription>
                로그인 actor와 파일에 기록할 질문 작성자는 별도 주체입니다. 실제 문구를 검토·작성한 사람의 이메일을 입력하세요.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="logged-in-actor">현재 로그인 actor</FieldLabel>
                  <Input id="logged-in-actor" value={actorEmail} readOnly aria-readonly="true" />
                  <FieldDescription>화면 접근 주체 표시이며 내보내는 파일의 작성자 증명이 아닙니다.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="question-author-email">파일의 질문 작성자 이메일</FieldLabel>
                  <Input
                    id="question-author-email"
                    type="email"
                    autoComplete="off"
                    placeholder="human-reviewer@example.com"
                    value={questionAuthorEmail}
                    onChange={(event) => setQuestionAuthorEmail(event.currentTarget.value)}
                  />
                  <FieldDescription>기존 manual CLI가 사람 이메일 형식과 AI 식별자 금지를 다시 검증합니다.</FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-end">
              <Button type="button" disabled={isImporting} onClick={downloadManualInput}>
                <DownloadIcon data-icon="inline-start" />
                {isImporting ? "파일 확인 중" : "결속된 Manual CLI 입력 내려받기"}
              </Button>
            </CardFooter>
          </Card>
        </>
      ) : null}
    </div>
  )
}

function Binding({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{value}</p>
    </div>
  )
}

function QuestionCard({
  item,
  onChange,
}: {
  item: EditableConfirmationQuestionDraftItem
  onChange: (
    update: (item: EditableConfirmationQuestionDraftItem) => EditableConfirmationQuestionDraftItem,
  ) => void
}) {
  const kindLabel = item.criterionKind === "required"
    ? "필수"
    : item.criterionKind === "preferred" ? "우대" : "제외"
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">조건 {item.criterionIndex + 1}</Badge>
          <Badge variant={item.criterionKind === "exclusion" ? "destructive" : "secondary"}>{kindLabel}</Badge>
          <Badge variant="outline">공고별 1회</Badge>
        </div>
        <CardTitle className="pt-2">2. 질문 문구와 평가 극성 검토</CardTitle>
        <CardDescription>
          평가 의미는 criterionKind 구조에서 고정됩니다. 질문이나 원문 표현을 보고 극성을 추론하지 않습니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel>검증된 원문 인용</FieldLabel>
            <blockquote className="rounded-lg border-l-4 bg-muted/40 p-3 text-sm leading-relaxed">{item.sourceSpan}</blockquote>
            <FieldDescription className="break-all">criterion SHA: {item.criterionSha256}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`prompt-${item.criterionIndex}`}>사용자 질문</FieldLabel>
            <Textarea
              id={`prompt-${item.criterionIndex}`}
              value={item.prompt}
              onChange={(event) => onChange(updateQuestionPrompt(event.currentTarget.value))}
            />
          </Field>
          <Field>
            <FieldLabel>고정 3상태 선택지</FieldLabel>
            <div className="grid gap-3 md:grid-cols-3">
              {item.options.map((option, optionIndex) => (
                <div key={option.value} className="rounded-lg border p-3">
                  <Input
                    aria-label={`조건 ${item.criterionIndex + 1} ${option.value} 선택지 문구`}
                    value={option.label}
                    onChange={(event) => onChange(updateQuestionOptionLabel(
                      optionIndex,
                      event.currentTarget.value,
                    ))}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {option.value} → {evaluationLabel(option.evaluation)}
                  </p>
                </div>
              ))}
            </div>
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-3">
        <span className="text-sm text-muted-foreground">이 후보를 명시적으로 포함하거나 제외해야 내보낼 수 있습니다.</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={item.decision === "exclude" ? "destructive" : "outline"}
            aria-pressed={item.decision === "exclude"}
            onClick={() => onChange((current) => ({ ...current, decision: "exclude" }))}
          >
            <XCircleIcon data-icon="inline-start" />
            제외
          </Button>
          <Button
            type="button"
            variant={item.decision === "include" ? "default" : "outline"}
            aria-pressed={item.decision === "include"}
            onClick={() => onChange((current) => ({ ...current, decision: "include" }))}
          >
            <CheckCircle2Icon data-icon="inline-start" />
            검토 후 포함
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

export function updateQuestionPrompt(
  prompt: string,
): (item: EditableConfirmationQuestionDraftItem) => EditableConfirmationQuestionDraftItem {
  return (item) => ({ ...item, prompt })
}

export function updateQuestionOptionLabel(
  optionIndex: number,
  label: string,
): (item: EditableConfirmationQuestionDraftItem) => EditableConfirmationQuestionDraftItem {
  return (item) => ({
    ...item,
    options: item.options.map((option, currentOptionIndex) =>
      currentOptionIndex === optionIndex ? { ...option, label } : option),
  })
}

function evaluationLabel(value: "satisfied" | "unsatisfied" | "unknown"): string {
  if (value === "satisfied") return "조건 충족"
  if (value === "unsatisfied") return "조건 미충족"
  return "확인 불가"
}

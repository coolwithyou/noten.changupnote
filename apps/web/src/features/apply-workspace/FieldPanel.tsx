"use client";

/**
 * 필드 패널 (Apply Experience v2 · §4.3 · P2-6).
 *
 * (a) 완전 경험: 연결 필드 카드 리스트(상태 뱃지·컨펌 규약·undo·FieldLessonTips·오버레이 동기화).
 * (b) 프리뷰만: "필드 분석 중" 안내 + draft.missingFields 기반 질문 카드(입력→초안 재생성 트리거).
 *
 * 진행률은 이 패널이 아니라 WorkspaceFooter 에 있다(§4.3).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, CircleDot, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult, DraftGenerationResult, MissingFieldQuestion } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { FieldLessonTips } from "@/features/knowledge/FieldLessonTips";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { DraftFieldAnswers, DraftFieldAnswerStatus } from "@/lib/server/documents/fieldAnswers";
import type { FieldLessonTipsDto } from "@/lib/server/knowledge/lessonContext";
import type { WorkspaceLadder } from "@/lib/server/documents/workspaceData";
import { answerKey } from "./fieldAnswerState";
import { FieldCard } from "./FieldCard";
import { WorkspaceDownloadButton } from "./WorkspaceFooter";
import { workspaceFieldState } from "./workspacePresentation";

export type WorkspacePanelMode = "single" | "list";

export function FieldPanel({
  ladder,
  grantId,
  activeDocumentKey,
  connectedFields,
  answers,
  duplicateLabels,
  suggestableLabels,
  fieldLessonTips,
  missingFields,
  selectedFieldId,
  pendingLabels,
  suggestingLabels,
  onSelectField,
  patchAnswer,
  onAskField,
  onRequestSuggestion,
  mode,
  draftId,
  hwpxTemplateAvailable,
}: {
  ladder: WorkspaceLadder;
  grantId: string;
  activeDocumentKey: string | null;
  connectedFields: ConnectedDocumentField[];
  answers: DraftFieldAnswers;
  duplicateLabels: Set<string>;
  /** '제안 받기' 노출 대상 원문 label 집합(서버 판정, P4). */
  suggestableLabels: Set<string>;
  fieldLessonTips: FieldLessonTipsDto | null;
  missingFields: MissingFieldQuestion[];
  selectedFieldId: string | null;
  pendingLabels: Set<string>;
  /** 제안 생성 진행 중인 정규화 label 집합(로딩 스피너). */
  suggestingLabels: Set<string>;
  onSelectField: (fieldId: string) => void;
  patchAnswer: (label: string, entry: { value?: string; status: DraftFieldAnswerStatus }) => void;
  /** "이 항목이 뭐예요?" → 채팅 프리필(ADR-9). */
  onAskField: (field: ConnectedDocumentField) => void;
  /** "제안 받기"/"다시 제안" → LLM 필드 제안(P4). */
  onRequestSuggestion: (field: ConnectedDocumentField) => void;
  mode: WorkspacePanelMode;
  draftId: string | null;
  hwpxTemplateAvailable: boolean;
}) {
  const tipsByLabel = fieldLessonTips?.byLabel ?? {};

  if (ladder === "b") {
    return (
      <div className="grid gap-3 p-3">
        <FieldAnalyzingNotice />
        {activeDocumentKey ? (
          <MissingFieldQuestions
            grantId={grantId}
            documentKey={activeDocumentKey}
            questions={missingFields}
            tipsByLabel={tipsByLabel}
          />
        ) : null}
      </div>
    );
  }

  if (connectedFields.length === 0) {
    return (
      <div className="p-3">
        <Empty className="min-h-40 border-0">
          <EmptyHeader>
            <EmptyTitle>표시할 작성 항목이 없습니다.</EmptyTitle>
            <EmptyDescription>이 문서에서 연결된 작성 항목을 찾지 못했습니다.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const duplicateFieldCount = connectedFields.filter((field) => duplicateLabels.has(field.label)).length;
  const hasDuplicateConflicts = duplicateFieldCount > 0;
  const isComplete =
    pendingLabels.size === 0 &&
    connectedFields.every((field) => workspaceFieldState(answers[answerKey(field.label)]) === "filled");

  if (mode === "list") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">전체 항목 {connectedFields.length.toLocaleString("ko-KR")}</h2>
          <span className="text-xs text-muted-foreground">항목을 선택하면 하나씩 확인할 수 있어요.</span>
        </div>
        <div className="flex flex-col gap-1">
          {connectedFields.map((field) => {
            const answer = answers[answerKey(field.label)];
            const state = workspaceFieldState(answer);
            return (
              <Button
                key={field.fieldId}
                type="button"
                variant="ghost"
                className="h-auto min-w-0 justify-start gap-3 px-3 py-3 text-left"
                onClick={() => onSelectField(field.fieldId)}
              >
                <FieldStateIcon state={state} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{field.label}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {state === "empty" ? "비어 있음" : answer?.value?.trim() || "비어 있음"}
                  </span>
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {state === "filled" ? "확인 완료" : state === "reviewing" ? "확인 중" : "미입력"}
                </span>
              </Button>
            );
          })}
        </div>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div className="p-4">
        <Card className="text-center shadow-[var(--shadow-subtle)]">
          <CardHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
              <Check aria-hidden />
            </div>
            <CardTitle className="text-xl">
              {hasDuplicateConflicts ? "확인 가능한 항목 검토 끝" : "모든 항목 확인 끝!"}
            </CardTitle>
            <CardDescription>
              {hasDuplicateConflicts
                ? `이름이 겹치는 ${duplicateFieldCount.toLocaleString("ko-KR")}개 항목은 자동 채움에서 제외됩니다. 내려받은 원본 파일에서 직접 확인하고 입력해 주세요.`
                : "확정한 값으로 원본 신청서를 채웠어요. 내려받아 제출 전에 마지막으로 확인해 주세요."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hwpxTemplateAvailable ? (
              <WorkspaceDownloadButton
                draftId={draftId}
                label={hasDuplicateConflicts
                  ? "직접 확인할 신청서 내려받기 (HWPX)"
                  : "함께 완성한 신청서 내려받기 (HWPX)"}
                className="w-full"
                saving={pendingLabels.size > 0}
              />
            ) : (
              <p className="text-sm text-muted-foreground">이 서류는 원본 양식 채움을 지원하지 않습니다.</p>
            )}
          </CardContent>
          <CardFooter className="justify-center bg-card text-xs text-muted-foreground">
            전체 목록에서 각 항목을 다시 확인할 수 있어요.
          </CardFooter>
        </Card>
      </div>
    );
  }

  const activeField = connectedFields.find((field) => field.fieldId === selectedFieldId)
    ?? connectedFields.find((field) => workspaceFieldState(answers[answerKey(field.label)]) !== "filled")
    ?? connectedFields[0]!;
  const activeIndex = connectedFields.findIndex((field) => field.fieldId === activeField.fieldId);
  const key = answerKey(activeField.label);
  const nextField = connectedFields
    .slice(activeIndex + 1)
    .concat(connectedFields.slice(0, activeIndex))
    .find((field) => workspaceFieldState(answers[answerKey(field.label)]) !== "filled");

  return (
    <div className="p-4">
      <FieldCard
        field={activeField}
        answer={answers[key]}
        position={activeIndex + 1}
        total={connectedFields.length}
        isDuplicate={duplicateLabels.has(activeField.label)}
        isSelected
        isPending={pendingLabels.has(key)}
        isSuggestable={suggestableLabels.has(activeField.label)}
        isSuggesting={suggestingLabels.has(key)}
        tips={tipsByLabel[activeField.label] ?? []}
        onAccept={() => patchAnswer(key, { status: "accepted" })}
        onSave={(value) => patchAnswer(key, { value, status: "edited" })}
        onDismiss={() => patchAnswer(key, { status: "dismissed" })}
        onUndo={() => {
          const suggestedValue = answers[key]?.suggestedValue;
          if (suggestedValue !== undefined) patchAnswer(key, { value: suggestedValue, status: "suggested" });
        }}
        onAsk={() => onAskField(activeField)}
        onNext={() => {
          if (nextField) onSelectField(nextField.fieldId);
        }}
        onRequestSuggestion={() => onRequestSuggestion(activeField)}
      />
    </div>
  );
}

function FieldStateIcon({ state }: { state: ReturnType<typeof workspaceFieldState> }) {
  if (state === "filled") return <Check className="shrink-0 text-success" aria-label="확인 완료" />;
  if (state === "reviewing") return <CircleDot className="shrink-0 text-primary" aria-label="확인 중" />;
  return <Circle className="shrink-0 text-muted-foreground" aria-label="미입력" />;
}

function FieldAnalyzingNotice() {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-lg)] border border-sky-500/30 bg-sky-500/[0.06] p-3 text-sm">
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-sky-600 dark:text-sky-400" aria-hidden />
      <div className="grid gap-0.5">
        <span className="font-medium text-foreground">작성 항목을 분석하고 있습니다</span>
        <span className="text-muted-foreground">
          문서 프리뷰는 준비됐지만 항목별 채움은 아직 분석 중입니다. 아래 질문에 답하면 초안에 먼저 반영해
          드릴게요.
        </span>
      </div>
    </div>
  );
}

function MissingFieldQuestions({
  grantId,
  documentKey,
  questions,
  tipsByLabel,
}: {
  grantId: string;
  documentKey: string;
  questions: MissingFieldQuestion[];
  tipsByLabel: FieldLessonTipsDto["byLabel"];
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  if (questions.length === 0) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        현재 회사 프로필과 공고 정보만으로 초안을 만들 수 있습니다. 분석이 끝나면 항목별 카드가 나타납니다.
      </p>
    );
  }

  async function regenerate() {
    const answers: Record<string, string> = {};
    for (const [label, value] of Object.entries(values)) {
      const trimmed = value.trim();
      if (trimmed) answers[label] = trimmed;
    }
    setPending(true);
    try {
      const response = await fetch(`/api/web/grants/${encodeURIComponent(grantId)}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentKey,
          ...(Object.keys(answers).length > 0 ? { answers } : {}),
        }),
      });
      const payload = (await response.json()) as ActionResult<DraftGenerationResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초안을 다시 만들지 못했습니다.");
      }
      toast.success("입력을 반영해 초안을 다시 만들었습니다. 화면을 새로고침합니다.");
      router.refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "초안을 다시 만들지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3">
        {questions.map((question) => (
          <Field key={question.fieldKey}>
            <FieldLabel htmlFor={`missing-${safeId(question.fieldKey)}`}>{question.label}</FieldLabel>
            <Textarea
              id={`missing-${safeId(question.fieldKey)}`}
              value={values[question.label] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [question.label]: event.currentTarget.value }))
              }
              placeholder={`${question.label}을(를) 입력해주세요.`}
              disabled={pending}
              rows={2}
            />
            {question.reason ? <FieldDescription>{question.reason}</FieldDescription> : null}
            {tipsByLabel[question.label]?.length ? <FieldLessonTips tips={tipsByLabel[question.label]!} /> : null}
          </Field>
        ))}
      </div>
      <Button type="button" size="sm" onClick={() => void regenerate()} disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
        이 입력으로 다시 만들기
      </Button>
    </div>
  );
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

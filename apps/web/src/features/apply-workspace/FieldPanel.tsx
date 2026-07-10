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
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult, DraftGenerationResult, MissingFieldQuestion } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="grid gap-3 p-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">작성 항목 {connectedFields.length.toLocaleString("ko-KR")}</h2>
        <span className="text-xs text-muted-foreground">항목을 확인하고 반영/수정/건너뛰기</span>
      </div>
      <div className="grid gap-2">
        {connectedFields.map((field) => {
          const key = answerKey(field.label);
          const answer = answers[key];
          return (
            <FieldCard
              key={field.fieldId}
              field={field}
              answer={answer}
              isDuplicate={duplicateLabels.has(field.label)}
              isSelected={selectedFieldId === field.fieldId}
              isPending={pendingLabels.has(key)}
              isSuggestable={suggestableLabels.has(field.label)}
              isSuggesting={suggestingLabels.has(key)}
              tips={tipsByLabel[field.label] ?? []}
              onSelect={() => onSelectField(field.fieldId)}
              onAccept={() => patchAnswer(key, { status: "accepted" })}
              onSave={(value) => patchAnswer(key, { value, status: "edited" })}
              onDismiss={() => patchAnswer(key, { status: "dismissed" })}
              onUndo={() => {
                const suggestedValue = answers[key]?.suggestedValue;
                if (suggestedValue !== undefined) {
                  patchAnswer(key, { value: suggestedValue, status: "suggested" });
                }
              }}
              onAsk={() => onAskField(field)}
              onRequestSuggestion={() => onRequestSuggestion(field)}
            />
          );
        })}
      </div>
    </div>
  );
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

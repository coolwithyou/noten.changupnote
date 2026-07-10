"use client";

/**
 * (c) 폴백 초안 편집기 (Apply Experience v2 · §4.4(c)/§4.3 · P2-9).
 *
 * 구 `apply-sheet/DocumentDraftWorkspace` 를 workspace 로 이식한 것. 사다리 (c)(변환 전/실패/.doc·웹폼 —
 * 연결 필드 0건)에서 채팅 전면과 함께 렌더된다. 이식 규범(설계 §4.3): 초안 markdown 편집 · DOCX/MD/HTML
 * 내보내기 · 섹션 재생성 · 품질 피드백 · 추가 입력(생성 반영) · 문항별 자동채움 편집.
 *
 * ADR-5 클라이언트 규약 전환(P2-9 몫):
 *  - 구 PATCH 의 `filledFields` 동봉을 제거한다. 초안 저장은 `{draftMarkdown, status}` 만 보낸다.
 *  - 필드 값 변경은 신 `field-answers` PATCH(edited/dismissed)로만 영속화한다(컨펌 게이트 서버 집행).
 *  - 섹션 재생성 body 에서도 `filledFields` 를 제거한다 — 서버가 저장된 fieldAnswers 로 확정값을 보존한다.
 *  - HWPX 채움 다운로드(구 answers 동봉)는 이 편집기에서 제거했다. HWPX 는 하단 바(WorkspaceFooter)가
 *    `{format:"hwpx"}` 만 보내 담당한다(설계 §4.3 하단 바).
 */
import { useMemo, useState } from "react";
import { Check, Download, FileText, Loader2, MessageSquare, Printer, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import type {
  ActionResult,
  ApplicationPrep,
  DocumentDraft,
  DocumentDraftFeedbackKind,
  DocumentDraftFeedbackResult,
  DraftableDocument,
  DraftGenerationResult,
  MissingFieldQuestion,
} from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FieldLessonTips } from "@/features/knowledge/FieldLessonTips";
import type { DraftFieldAnswers, DraftFieldAnswerStatus } from "@/lib/server/documents/fieldAnswers";
import type { FieldLessonTipsDto } from "@/lib/server/knowledge/lessonContext";

interface DraftFeedbackFormState {
  kind: DocumentDraftFeedbackKind;
  message: string;
}

const DRAFT_FEEDBACK_OPTIONS: Array<{ value: DocumentDraftFeedbackKind; label: string }> = [
  { value: "incorrect_fact", label: "사실 오류" },
  { value: "missing_context", label: "맥락 부족" },
  { value: "format_issue", label: "양식 불일치" },
  { value: "too_generic", label: "내용이 일반적임" },
  { value: "other", label: "기타" },
];

export function DraftFallbackEditor({
  grantId,
  prep,
  initialDrafts = [],
  fieldLessonTips = null,
}: {
  grantId: string;
  prep: ApplicationPrep;
  initialDrafts?: DocumentDraft[];
  fieldLessonTips?: FieldLessonTipsDto | null;
}) {
  const initialDraftMap = useMemo(
    () => draftMapFromList(initialDrafts, prep.draftableDocuments),
    [initialDrafts, prep.draftableDocuments],
  );
  const [drafts, setDrafts] = useState<Record<string, DocumentDraft>>(() => initialDraftMap);
  const [draftText, setDraftText] = useState<Record<string, string>>(() => draftTextFromMap(initialDraftMap));
  const [fieldText, setFieldText] = useState<Record<string, Record<string, string>>>(() => fieldTextFromMap(initialDraftMap));
  const [answerText, setAnswerText] = useState<Record<string, string>>({});
  const [sectionSelections, setSectionSelections] = useState<Record<string, string>>({});
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, DraftFeedbackFormState>>({});
  const [activeKey, setActiveKey] = useState<string | null>(() =>
    firstDraftableKeyWithDraft(prep, initialDraftMap) ?? prep.draftableDocuments[0]?.documentKey ?? null
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedbackPendingKey, setFeedbackPendingKey] = useState<string | null>(null);
  const activeDocument = useMemo(
    () => prep.draftableDocuments.find((document) => document.documentKey === activeKey) ?? null,
    [activeKey, prep.draftableDocuments],
  );
  const activeQuestions = useMemo(
    () => activeDocument ? questionsForDocument(prep, activeDocument) : [],
    [activeDocument, prep],
  );
  const activeDraft = activeKey ? drafts[activeKey] : null;
  const activeSectionTitles = useMemo(
    () => activeDraft && activeKey ? draftSectionTitles(draftText[activeKey] ?? activeDraft.draftMarkdown) : [],
    [activeDraft, activeKey, draftText],
  );
  const selectedSectionTitle = activeKey ? sectionSelections[activeKey] : undefined;
  const activeSectionTitle = selectedSectionTitle && activeSectionTitles.includes(selectedSectionTitle)
    ? selectedSectionTitle
    : activeSectionTitles[0] ?? "";

  async function generateDraft(document: DraftableDocument) {
    setPendingKey(document.documentKey);
    const answerPayload = draftAnswersForDocument(document, prep, answerText);
    const sentAnswers = Boolean(answerPayload.answers && Object.keys(answerPayload.answers).length > 0);
    try {
      const response = await fetch(`/api/web/grants/${encodeURIComponent(grantId)}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentKey: document.documentKey,
          ...answerPayload,
        }),
      });
      const payload = (await response.json()) as ActionResult<DraftGenerationResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초안을 만들지 못했습니다.");
      }
      setDrafts((current) => ({ ...current, [document.documentKey]: payload.data!.draft }));
      setDraftText((current) => ({ ...current, [document.documentKey]: payload.data!.draft.draftMarkdown }));
      setFieldText((current) => ({ ...current, [document.documentKey]: payload.data!.draft.filledFields }));
      setActiveKey(document.documentKey);
      toast.success(
        `${document.canonicalName} 초안을 만들었습니다. 내용을 확인한 뒤 저장하거나 검토 완료로 표시하세요.${
          sentAnswers ? " 입력한 값은 회사 프로필에 저장돼 다음 서류에서 자동 반영됩니다." : ""
        }`,
      );
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "초안을 만들지 못했습니다.");
    } finally {
      setPendingKey(null);
    }
  }

  // ADR-5: 문항별 자동채움 편집(fieldText)의 변경분을 신 field-answers PATCH(edited/dismissed)로 영속화한다.
  // 컨펌 게이트를 서버가 집행하므로 클라이언트가 filledFields 를 직접 쓰지 않는다. 초안 저장·재생성·내보내기
  // 앞단에서 호출해 사용자 필드 편집을 먼저 반영한다. 서버 파생 filledFields 로 로컬 기준선을 전진시킨다.
  async function flushFieldAnswers(document: DraftableDocument): Promise<void> {
    const draft = drafts[document.documentKey];
    if (!draft) return;
    const baseline = draft.filledFields;
    const local = fieldText[document.documentKey] ?? baseline;
    const patch: Record<string, { value: string; status: DraftFieldAnswerStatus }> = {};
    const seen = new Set<string>();
    for (const [rawLabel, rawValue] of Object.entries(local)) {
      const label = rawLabel.trim();
      if (!label) continue;
      seen.add(label);
      const value = rawValue.trim();
      const previous = (baseline[label] ?? "").trim();
      if (value === previous) continue;
      patch[label] = value ? { value, status: "edited" } : { value: "", status: "dismissed" };
    }
    // 로컬에서 제거된(비워진) 기존 값은 dismissed 로 확정 해제한다.
    for (const [rawLabel, rawValue] of Object.entries(baseline)) {
      const label = rawLabel.trim();
      if (!label || seen.has(label)) continue;
      if (rawValue.trim()) patch[label] = { value: "", status: "dismissed" };
    }
    if (Object.keys(patch).length === 0) return;
    const response = await fetch(`/api/web/document-drafts/${encodeURIComponent(draft.id)}/field-answers`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: patch }),
    });
    const payload = (await response.json()) as ActionResult<{
      fieldAnswers: DraftFieldAnswers;
      filledFields: Record<string, string>;
    }>;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "필드 값을 저장하지 못했습니다.");
    }
    const filledFields = payload.data.filledFields;
    setDrafts((current) => {
      const existing = current[document.documentKey];
      if (!existing) return current;
      return { ...current, [document.documentKey]: { ...existing, filledFields } };
    });
    setFieldText((current) => ({ ...current, [document.documentKey]: filledFields }));
  }

  async function updateDraft(document: DraftableDocument, status?: DocumentDraft["status"]): Promise<DocumentDraft | null> {
    const draft = drafts[document.documentKey];
    if (!draft) return null;
    setPendingKey(document.documentKey);
    try {
      // ADR-5: 필드 값은 field-answers PATCH 로 먼저 반영하고, 초안 저장 body 에는 filledFields 를 동봉하지 않는다.
      await flushFieldAnswers(document);
      const response = await fetch(`/api/web/document-drafts/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftMarkdown: draftText[document.documentKey] ?? draft.draftMarkdown,
          ...(status ? { status } : {}),
        }),
      });
      const payload = (await response.json()) as ActionResult<DocumentDraft>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초안을 저장하지 못했습니다.");
      }
      setDrafts((current) => ({ ...current, [document.documentKey]: payload.data! }));
      setDraftText((current) => ({ ...current, [document.documentKey]: payload.data!.draftMarkdown }));
      setFieldText((current) => ({ ...current, [document.documentKey]: payload.data!.filledFields }));
      // "exported" 상태 저장은 downloadDraft() 가 이어서 자체 완료 토스트를 띄우므로 여기서는 중복 알림을 생략한다.
      if (status !== "exported") {
        toast.success(
          status === "reviewed"
            ? `${document.canonicalName} 초안을 검토 완료로 표시했습니다.`
            : `${document.canonicalName} 초안을 저장했습니다.`,
        );
      }
      return payload.data;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "초안을 저장하지 못했습니다.");
      return null;
    } finally {
      setPendingKey(null);
    }
  }

  async function regenerateDraftSection(document: DraftableDocument, sectionTitle: string) {
    const draft = drafts[document.documentKey];
    if (!draft || !sectionTitle) return;
    const previousMarkdown = draftText[document.documentKey] ?? draft.draftMarkdown;
    setPendingKey(document.documentKey);
    try {
      // ADR-5: 사용자 필드 편집을 서버에 먼저 반영(재생성이 파생 filledFields 를 재계산하기 전). 재생성 body 에
      // filledFields 를 동봉하지 않는다 — 서버가 저장된 fieldAnswers 로 확정값(accepted|edited)을 보존한다.
      await flushFieldAnswers(document);
      const response = await fetch(`/api/web/document-drafts/${encodeURIComponent(draft.id)}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sectionTitle,
          draftMarkdown: previousMarkdown,
          ...draftAnswersForDocument(document, prep, answerText),
        }),
      });
      const payload = (await response.json()) as ActionResult<DocumentDraft>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "선택한 섹션을 다시 생성하지 못했습니다.");
      }
      setDrafts((current) => ({ ...current, [document.documentKey]: payload.data! }));
      setDraftText((current) => ({ ...current, [document.documentKey]: payload.data!.draftMarkdown }));
      setFieldText((current) => ({ ...current, [document.documentKey]: payload.data!.filledFields }));
      if (payload.data!.draftMarkdown === previousMarkdown) {
        toast.warning(
          `『${sectionTitle}』 섹션 내용이 달라지지 않았습니다. 이 초안은 회사 프로필과 추가 입력을 반영하는 고정 골격이라, 위 추가 입력을 채운 뒤 다시 생성하면 문장이 바뀝니다.`,
        );
      } else {
        toast.success(`${sectionTitle} 섹션을 다시 생성했습니다. 변경된 문장을 확인한 뒤 저장하세요.`);
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "선택한 섹션을 다시 생성하지 못했습니다.");
    } finally {
      setPendingKey(null);
    }
  }

  async function downloadDraft(document: DraftableDocument, format: "markdown" | "html" | "docx" | "pdf") {
    const saved = await updateDraft(document, "exported");
    if (!saved) return;
    toast.success(`${document.canonicalName} 초안을 저장했고 다운로드를 시작합니다.`);
    const query = format === "markdown" ? "" : `?format=${format}`;
    window.location.assign(`/api/web/document-drafts/${encodeURIComponent(saved.id)}/download${query}`);
  }

  async function submitDraftFeedback(draft: DocumentDraft) {
    const form = feedbackDrafts[draft.id] ?? defaultDraftFeedbackFormState();
    setFeedbackPendingKey(draft.id);
    try {
      const response = await fetch(`/api/web/document-drafts/${encodeURIComponent(draft.id)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: form.kind,
          message: form.message,
        }),
      });
      const payload = (await response.json()) as ActionResult<DocumentDraftFeedbackResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "초안 피드백을 저장하지 못했습니다.");
      }
      setFeedbackDrafts((current) => ({
        ...current,
        [draft.id]: { ...form, message: "" },
      }));
      toast.success("피드백을 저장했습니다. 다음 초안 품질 개선에 반영됩니다.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "초안 피드백을 저장하지 못했습니다.");
    } finally {
      setFeedbackPendingKey(null);
    }
  }

  return (
    <div className="document-draft-workspace">
      <div className="document-draft-summary">
        <SummaryMetric label="AI 초안" value={`${prep.draftCoverage.draftableCount}개`} />
        <SummaryMetric label="발급" value={`${prep.draftCoverage.issuableCount}개`} />
        <SummaryMetric label="첨부" value={`${prep.draftCoverage.attachableCount}개`} />
        <SummaryMetric label="입력 필요" value={`${prep.draftCoverage.missingFieldCount}개`} tone={prep.draftCoverage.missingFieldCount > 0 ? "warning" : "success"} />
      </div>

      {prep.draftableDocuments.length === 0 ? (
        <Empty className="panel-empty">
          <EmptyDescription>AI 초안 작성이 가능한 작성형 서류가 아직 없습니다.</EmptyDescription>
        </Empty>
      ) : (
        <div className="document-draft-grid">
          <div className="document-draft-list" aria-label="AI 초안 작성 가능 서류">
            {prep.draftableDocuments.map((document) => {
              const draft = drafts[document.documentKey];
              const pending = pendingKey === document.documentKey;
              return (
                <Card
                  key={document.documentKey}
                  className={activeKey === document.documentKey ? "document-draft-row active" : "document-draft-row"}
                  size="sm"
                >
                  <CardContent className="p-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="document-draft-select"
                      aria-current={activeKey === document.documentKey ? "true" : undefined}
                      onClick={() => setActiveKey(document.documentKey)}
                    >
                      <StatusBadge tone={draftTone(draft?.status ?? document.status)}>
                        {draft ? draftStatusLabel(draft.status) : preparationStatusLabel(document.status)}
                      </StatusBadge>
                      <h3>{document.canonicalName}</h3>
                      <p>{document.sourceAttachment ?? "연결 첨부 없음"}</p>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={draft ? "secondary" : "default"}
                      onClick={() => void generateDraft(document)}
                      disabled={pending}
                    >
                      {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileText className="size-3.5" aria-hidden />}
                      {draft ? "다시 생성" : "초안 만들기"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card className="document-draft-editor" size="sm">
            <CardContent className="p-0">
              {activeDocument ? (
                <>
                  <div className="document-draft-editor-head">
                    <div>
                      <span className="eyebrow">AI 초안</span>
                      <h3>{activeDocument.canonicalName}</h3>
                    </div>
                    {activeDraft ? <StatusBadge tone={draftTone(activeDraft.status)}>{draftStatusLabel(activeDraft.status)}</StatusBadge> : null}
                  </div>
                  <DraftAnswerPanel
                    document={activeDocument}
                    questions={activeQuestions}
                    tipsByLabel={fieldLessonTips?.byLabel ?? {}}
                    values={answerText}
                    disabled={pendingKey === activeDocument.documentKey}
                    onChange={(question, value) =>
                      setAnswerText((current) => ({
                        ...current,
                        [question.label]: value,
                      }))
                    }
                  />
                  {activeDraft ? (
                    <>
                      <div className="document-draft-editor-body">
                        <Textarea
                          value={draftText[activeDocument.documentKey] ?? activeDraft.draftMarkdown}
                          onChange={(event) =>
                            setDraftText((current) => ({
                              ...current,
                              [activeDocument.documentKey]: event.target.value,
                            }))
                          }
                          aria-label={`${activeDocument.canonicalName} 초안`}
                        />
                        <DraftAutofillReview
                          draft={activeDraft}
                          values={fieldText[activeDocument.documentKey] ?? activeDraft.filledFields}
                          disabled={pendingKey === activeDocument.documentKey}
                          onChange={(label, value) =>
                            setFieldText((current) => ({
                              ...current,
                              [activeDocument.documentKey]: {
                                ...(current[activeDocument.documentKey] ?? activeDraft.filledFields),
                                [label]: value,
                              },
                            }))
                          }
                        />
                      </div>
                      <DraftSectionRegenerationPanel
                        sectionTitles={activeSectionTitles}
                        value={activeSectionTitle}
                        pending={pendingKey === activeDocument.documentKey}
                        onChange={(sectionTitle) =>
                          setSectionSelections((current) => ({
                            ...current,
                            [activeDocument.documentKey]: sectionTitle,
                          }))
                        }
                        onRegenerate={() => void regenerateDraftSection(activeDocument, activeSectionTitle)}
                      />
                      <div className="document-draft-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void updateDraft(activeDocument)}
                          disabled={pendingKey === activeDocument.documentKey}
                        >
                          <Save className="size-3.5" aria-hidden />
                          저장
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void updateDraft(activeDocument, "reviewed")}
                          disabled={pendingKey === activeDocument.documentKey}
                        >
                          <Check className="size-3.5" aria-hidden />
                          검토 완료
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void downloadDraft(activeDocument, "docx")}
                          disabled={pendingKey === activeDocument.documentKey}
                        >
                          <Download className="size-3.5" aria-hidden />
                          DOCX(한글에 붙여넣기)
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void downloadDraft(activeDocument, "markdown")}
                          disabled={pendingKey === activeDocument.documentKey}
                        >
                          <Download className="size-3.5" aria-hidden />
                          Markdown
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void downloadDraft(activeDocument, "html")}
                          disabled={pendingKey === activeDocument.documentKey}
                        >
                          <Printer className="size-3.5" aria-hidden />
                          인쇄용 HTML
                        </Button>
                      </div>
                      <DraftMeta draft={activeDraft} />
                      <DraftFeedbackPanel
                        draft={activeDraft}
                        value={feedbackDrafts[activeDraft.id] ?? defaultDraftFeedbackFormState()}
                        pending={feedbackPendingKey === activeDraft.id}
                        onChange={(value) =>
                          setFeedbackDrafts((current) => ({
                            ...current,
                            [activeDraft.id]: value,
                          }))
                        }
                        onSubmit={() => void submitDraftFeedback(activeDraft)}
                      />
                    </>
                  ) : (
                    <Empty className="panel-empty">
                      <EmptyDescription>초안을 만들면 이 영역에서 바로 검토하고 저장할 수 있습니다.</EmptyDescription>
                    </Empty>
                  )}
                </>
              ) : (
                <Empty className="panel-empty">
                  <EmptyDescription>초안을 만들 서류를 선택하세요.</EmptyDescription>
                </Empty>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function DraftAnswerPanel({
  document,
  questions,
  tipsByLabel,
  values,
  disabled,
  onChange,
}: {
  document: DraftableDocument;
  questions: MissingFieldQuestion[];
  tipsByLabel: FieldLessonTipsDto["byLabel"];
  values: Record<string, string>;
  disabled: boolean;
  onChange: (question: MissingFieldQuestion, value: string) => void;
}) {
  return (
    <div className="document-draft-answer-panel">
      <div className="document-draft-answer-head">
        <div>
          <span>초안에 반영할 추가 입력</span>
          <strong>{questions.length > 0 ? `${questions.length.toLocaleString("ko-KR")}개 항목` : "추가 입력 없음"}</strong>
        </div>
        <StatusBadge tone={questions.length > 0 ? "warning" : "success"}>
          {questions.length > 0 ? "입력 반영 가능" : "프로필 충분"}
        </StatusBadge>
      </div>
      {questions.length > 0 ? (
        <div className="document-draft-answer-list">
          {questions.map((question) => (
            <Field key={`${document.documentKey}:${question.fieldKey}`}>
              <FieldLabel htmlFor={answerFieldId(document, question)}>{question.label}</FieldLabel>
              <Textarea
                id={answerFieldId(document, question)}
                value={values[question.label] ?? ""}
                onChange={(event) => onChange(question, event.currentTarget.value)}
                placeholder={answerPlaceholder(question)}
                disabled={disabled}
              />
              <FieldDescription>{question.reason}</FieldDescription>
              {tipsByLabel[question.label]?.length ? (
                <FieldLessonTips tips={tipsByLabel[question.label]!} />
              ) : null}
            </Field>
          ))}
        </div>
      ) : (
        <p>현재 회사 프로필과 공고 정보만으로 1차 초안을 만들 수 있습니다.</p>
      )}
    </div>
  );
}

function DraftSectionRegenerationPanel({
  sectionTitles,
  value,
  pending,
  onChange,
  onRegenerate,
}: {
  sectionTitles: string[];
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="document-draft-section-panel">
      <div>
        <span>섹션별 다시 생성</span>
        <strong>선택한 섹션만 새 초안으로 교체합니다.</strong>
      </div>
      <div className="document-draft-section-controls">
        <Select
          value={value}
          disabled={pending || sectionTitles.length === 0}
          onValueChange={(nextValue) => {
            if (nextValue) onChange(nextValue);
          }}
        >
          <SelectTrigger aria-label="다시 생성할 초안 섹션">
            <SelectValue placeholder="섹션 선택" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {sectionTitles.map((sectionTitle) => (
                <SelectItem key={sectionTitle} value={sectionTitle}>
                  {sectionTitle}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button type="button" size="sm" variant="secondary" disabled={pending || !value} onClick={onRegenerate}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          섹션 재생성
        </Button>
      </div>
    </div>
  );
}

function draftMapFromList(
  drafts: DocumentDraft[],
  documents: DraftableDocument[],
): Record<string, DocumentDraft> {
  const allowedKeys = new Set(documents.map((document) => document.documentKey));
  const result: Record<string, DocumentDraft> = {};
  for (const draft of drafts) {
    if (!allowedKeys.has(draft.documentKey)) continue;
    if (!result[draft.documentKey]) result[draft.documentKey] = draft;
  }
  return result;
}

function draftTextFromMap(drafts: Record<string, DocumentDraft>): Record<string, string> {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.draftMarkdown]));
}

function fieldTextFromMap(drafts: Record<string, DocumentDraft>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.filledFields]));
}

function firstDraftableKeyWithDraft(
  prep: ApplicationPrep,
  drafts: Record<string, DocumentDraft>,
): string | null {
  return prep.draftableDocuments.find((document) => drafts[document.documentKey])?.documentKey ?? null;
}

function questionsForDocument(prep: ApplicationPrep, document: DraftableDocument): MissingFieldQuestion[] {
  return prep.missingProfileFields.filter((question) => {
    if (question.documentName && question.documentName !== document.name) return false;
    if (question.category && question.category !== document.category) return false;
    return true;
  });
}

function draftAnswersForDocument(
  document: DraftableDocument,
  prep: ApplicationPrep,
  answers: Record<string, string>,
): { answers?: Record<string, string> } {
  const questions = questionsForDocument(prep, document);
  const result: Record<string, string> = {};
  for (const question of questions) {
    const value = answers[question.label]?.trim();
    if (value) result[question.label] = value;
  }
  return Object.keys(result).length > 0 ? { answers: result } : {};
}

function answerFieldId(document: DraftableDocument, question: MissingFieldQuestion): string {
  return `draft-answer-${safeId(document.documentKey)}-${safeId(question.fieldKey)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function answerPlaceholder(question: MissingFieldQuestion): string {
  if (question.fieldKey === "business.product_summary") return "제품/서비스가 해결하는 문제와 핵심 기능을 적어주세요.";
  if (question.fieldKey === "business.apply_goal") return "이번 지원으로 달성할 목표와 사용 계획을 적어주세요.";
  if (question.fieldKey === "business.budget_items") return "항목별 단가, 수량, 집행 목적을 적어주세요.";
  if (question.fieldKey === "business.performance_summary") return "매출, 납품, PoC, 인증 등 확인 가능한 실적을 적어주세요.";
  return `${question.label}을 입력해주세요.`;
}

function SummaryMetric({
  label,
  value,
  tone = "brand",
}: {
  label: string;
  value: string;
  tone?: "brand" | "success" | "warning";
}) {
  return (
    <div className={`document-draft-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DraftMeta({ draft }: { draft: DocumentDraft }) {
  return (
    <div className="document-draft-meta">
      <div>
        <span>자동 반영</span>
        <strong>{draft.usedProfileFields.length > 0 ? draft.usedProfileFields.join(", ") : "없음"}</strong>
      </div>
      <div>
        <span>입력 필요</span>
        <strong>{draft.missingFields.length.toLocaleString("ko-KR")}개</strong>
      </div>
      <div>
        <span>주의</span>
        <strong>{draft.warnings.length.toLocaleString("ko-KR")}개</strong>
      </div>
    </div>
  );
}

function DraftFeedbackPanel({
  draft,
  value,
  pending,
  onChange,
  onSubmit,
}: {
  draft: DocumentDraft;
  value: DraftFeedbackFormState;
  pending: boolean;
  onChange: (value: DraftFeedbackFormState) => void;
  onSubmit: () => void;
}) {
  const kindId = `draft-feedback-kind-${safeId(draft.id)}`;
  const messageId = `draft-feedback-message-${safeId(draft.id)}`;
  return (
    <div className="document-draft-feedback-panel">
      <div className="document-draft-feedback-head">
        <div>
          <span>초안 품질 피드백</span>
          <strong>오류나 부족한 점을 남기면 품질 로그로 저장됩니다.</strong>
        </div>
        <MessageSquare className="size-4" aria-hidden />
      </div>
      <div className="document-draft-feedback-form">
        <Field>
          <FieldLabel htmlFor={kindId}>유형</FieldLabel>
          <Select
            value={value.kind}
            disabled={pending}
            onValueChange={(nextValue) => onChange({ ...value, kind: nextValue as DocumentDraftFeedbackKind })}
          >
            <SelectTrigger id={kindId} className="w-full">
              <SelectValue>{(selected) => feedbackKindLabel(selected)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {DRAFT_FEEDBACK_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={messageId}>메모</FieldLabel>
          <Textarea
            id={messageId}
            value={value.message}
            onChange={(event) => onChange({ ...value, message: event.currentTarget.value })}
            placeholder="틀린 수치, 누락된 근거, 기관 양식과 다른 부분을 적어주세요."
            disabled={pending}
          />
          <FieldDescription>제출 전 검토가 필요한 AI 초안 품질 신호로만 사용합니다.</FieldDescription>
        </Field>
        <Button type="button" size="sm" variant="secondary" onClick={onSubmit} disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <MessageSquare className="size-3.5" aria-hidden />}
          피드백 저장
        </Button>
      </div>
    </div>
  );
}

function DraftAutofillReview({
  draft,
  values,
  disabled,
  onChange,
}: {
  draft: DocumentDraft;
  values: Record<string, string>;
  disabled: boolean;
  onChange: (label: string, value: string) => void;
}) {
  const rows = draftAutofillRows(draft, values);
  const missingCount = rows.filter((row) => row.kind === "missing").length;
  const filledCount = rows.length - missingCount;
  return (
    <div className="document-draft-autofill-panel">
      <div className="document-draft-autofill-head">
        <div>
          <span>문항별 자동채움 편집</span>
          <strong>{filledCount.toLocaleString("ko-KR")} / {rows.length.toLocaleString("ko-KR")}개 값</strong>
        </div>
        <StatusBadge tone={missingCount > 0 ? "warning" : "success"}>
          {missingCount > 0 ? "검토 필요" : "값 준비"}
        </StatusBadge>
      </div>
      {rows.length > 0 ? (
        <div className="document-draft-autofill-editor">
          {rows.map((row) => (
            <Field className="document-draft-autofill-field" key={`${row.kind}:${row.label}`}>
              <div className="document-draft-autofill-field-head">
                <FieldLabel htmlFor={autofillFieldId(draft, row)}>{row.label}</FieldLabel>
                <StatusBadge tone={row.kind === "missing" ? "warning" : row.status === "수정됨" ? "success" : "brand"}>
                  {row.status}
                </StatusBadge>
              </div>
              <Textarea
                id={autofillFieldId(draft, row)}
                value={row.value}
                onChange={(event) => onChange(row.label, event.currentTarget.value)}
                placeholder={row.placeholder}
                disabled={disabled}
              />
              <FieldDescription>{row.description}</FieldDescription>
            </Field>
          ))}
        </div>
      ) : (
        <p>아직 자동 반영된 필드가 없습니다. 추가 입력을 채운 뒤 초안을 다시 생성하세요.</p>
      )}
      {draft.warnings.length > 0 ? (
        <ul className="document-draft-warning-list">
          {draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function preparationStatusLabel(status: DraftableDocument["status"]) {
  if (status === "needs_user_input") return "입력 필요";
  if (status === "draft_ready") return "초안 있음";
  if (status === "reviewed") return "검토됨";
  if (status === "done") return "완료";
  return "작성 가능";
}

function draftStatusLabel(status: DocumentDraft["status"]) {
  if (status === "needs_input") return "입력 필요";
  if (status === "reviewed") return "검토 완료";
  if (status === "exported") return "내보냄";
  if (status === "archived") return "보관됨";
  return "초안 저장";
}

function draftTone(status: DocumentDraft["status"] | DraftableDocument["status"]) {
  if (status === "reviewed" || status === "done" || status === "exported") return "success";
  if (status === "needs_input" || status === "needs_user_input") return "warning";
  return "brand";
}

function draftAutofillRows(draft: DocumentDraft, values: Record<string, string>): Array<{
  kind: "filled" | "missing";
  label: string;
  status: string;
  value: string;
  description: string;
  placeholder: string;
}> {
  const labels = new Set([
    ...Object.keys(draft.filledFields),
    ...Object.entries(values)
      .filter(([, value]) => value.trim().length > 0)
      .map(([label]) => label),
  ]);
  const filledRows = Array.from(labels)
    .filter((label) => label.trim().length > 0)
    .map((label) => {
      const value = values[label] ?? draft.filledFields[label] ?? "";
      const original = draft.filledFields[label] ?? "";
      const status = value.trim() && original && value !== original
        ? "수정됨"
        : draft.usedProfileFields.includes(label)
          ? "프로필"
          : "추가 입력";
      return {
        kind: "filled" as const,
        label,
        status,
        value,
        description: status === "프로필"
          ? "회사 프로필에서 자동 복사한 값입니다. 원문 양식에 맞지 않으면 수정해 저장하세요."
          : "사용자가 입력하거나 초안 생성 시 반영한 값입니다.",
        placeholder: `${label} 값을 입력하세요.`,
      };
    });
  const missingRows = draft.missingFields
    .filter((field) => !labels.has(field.label) && !labels.has(field.fieldKey))
    .map((field) => {
      const value = values[field.label] ?? values[field.fieldKey] ?? "";
      return {
        kind: value.trim() ? "filled" as const : "missing" as const,
        label: field.label,
        status: value.trim() ? "수정됨" : "입력 필요",
        value,
        description: field.reason,
        placeholder: answerPlaceholder(field),
      };
    });
  return [...filledRows, ...missingRows];
}

function defaultDraftFeedbackFormState(): DraftFeedbackFormState {
  return {
    kind: "too_generic",
    message: "",
  };
}

function feedbackKindLabel(value: unknown): string {
  const match = DRAFT_FEEDBACK_OPTIONS.find((option) => option.value === value);
  return match?.label ?? String(value ?? "");
}

function draftSectionTitles(markdown: string): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const title = match[1]!.trim().replace(/\s+/g, " ");
    if (!title || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

function autofillFieldId(
  draft: DocumentDraft,
  row: { label: string },
): string {
  return `draft-autofill-${safeId(draft.id)}-${safeUnicodeId(row.label)}`;
}

function safeUnicodeId(value: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/["'<>#.?[\]\\]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "field";
}

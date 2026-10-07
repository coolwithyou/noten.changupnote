"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionResult } from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectGroup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { assertWritingApplicationCurrent, type WritingApplicationReview } from "./writingFieldApplication";
import { companyScopedFetch } from "@/lib/navigation/companyContext";
import { writingCompositionEvidenceCount, writingCompositionText, writingParagraphKindLabels } from "@/lib/documents/writingComposition";
import type { WritingSections } from "@/lib/documents/writingSections";

type Editor = { text: string; revision: number; savedText: string };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await companyScopedFetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const result = await response.json() as ActionResult<T>;
  if (!result.ok || !result.data) throw new Error(result.error?.message ?? "문안을 처리하지 못했습니다.");
  return result.data;
}

/** 문안은 draft/field별로 보관한다. 이 패널의 저장은 양식 파일 반영을 의미하지 않는다. */
export interface WritingSectionsPanelProps {
  draftId: string;
  onDirtyChange: (dirty: boolean) => void;
  presentation?: "sheet" | "inline";
  selectedFieldId?: string | null;
  onSelectField?: (fieldId: string) => void;
  contextActions?: ReactNode;
  inspectField?: (fieldId: string, savedText: string) => Promise<{ beforeText: string; requiresConfirmation?: boolean } | null>;
  applySavedText?: (fieldId: string, text: string, review: { beforeText: string; overwriteConfirmed: boolean }) => Promise<void>;
}
export function WritingSectionsPanel({ draftId, onDirtyChange, presentation = "sheet", selectedFieldId, onSelectField, contextActions, inspectField, applySavedText }: WritingSectionsPanelProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WritingSections | null>(null);
  const [fieldId, setFieldId] = useState<string | null>(null);
  const [editors, setEditors] = useState<Record<string, Editor>>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [application, setApplication] = useState<WritingApplicationReview | null>(null);
  const [compare, setCompare] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const pending = useRef<{ fieldId: string; revision: number; requestId: string } | null>(null);
  const endpoint = `/api/web/document-drafts/${encodeURIComponent(draftId)}/writing-sections`;
  const section = data?.sections.find(section => section.fieldId === fieldId);
  const editor = fieldId ? editors[fieldId] : undefined;
  const changed = editor && editor.text !== editor.savedText;
  const dirty = Object.values(editors).some(editor => editor.text !== editor.savedText);

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (presentation === "inline") void run(refresh);
    // One load per draft; document changes remount the keyed panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, presentation]);
  useEffect(() => {
    if (selectedFieldId && data?.sections.some(section => section.fieldId === selectedFieldId)) {
      setFieldId(selectedFieldId); setCompare(false); setApplication(null);
    }
  }, [selectedFieldId, data?.sections.length]);
  function receive(value: WritingSections) {
    setData(value);
    setFieldId(current => current ?? value.sections[0]?.fieldId ?? null);
    setEditors(current => {
      const next = { ...current };
      for (const section of value.sections) if (!next[section.fieldId]) next[section.fieldId] = { text: section.text, savedText: section.text, revision: section.revision };
      return next;
    });
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "문안을 처리하지 못했습니다."); }
    finally { lock.current = false; setBusy(false); }
  }
  async function refresh() { receive(await request<WritingSections>(endpoint)); }
  async function save(): Promise<number> {
    if (!fieldId || !editor) throw new Error("문항을 선택해 주세요.");
    if (!changed) return editor.revision;
    const saved = await request<{ revision: number; text: string }>(endpoint, { method: "PUT",
      body: JSON.stringify({ fieldId, expectedRevision: editor.revision, text: editor.text }) });
    setEditors(current => ({ ...current, [fieldId]: { ...saved, savedText: saved.text } }));
    setData(current => current ? { ...current, consistency: null, sections: current.sections.map(section => section.fieldId === fieldId ? { ...section, ...saved } : section) } : current);
    return saved.revision;
  }
  function changeText(text: string) {
    setApplication(null);
    if (fieldId && editor) setEditors(current => ({ ...current, [fieldId]: { ...editor, text } }));
  }
  const suggestion = section?.proposal;
  const proposalIsCurrent = suggestion && !suggestion.stale && editor?.revision === suggestion.baseRevision && !changed;
  const evidenceCount = suggestion?.composition ? writingCompositionEvidenceCount(suggestion.composition) : 0;
  const content = <div className="flex min-w-0 flex-col gap-4">
          {contextActions ? <details><summary className="cursor-pointer text-sm font-medium">회사 자료·이번 사업 설명</summary><div className="mt-3">{contextActions}<p className="mt-2 text-xs text-muted-foreground">선택한 회사 자료와 이번 신청의 사업 설명을 확인해 주세요. 확인되지 않은 내용은 사실로 채우지 않아요.</p></div></details> : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {!data ? <Button disabled={busy} onClick={() => void run(refresh)}>{busy ? "불러오는 중…" : "다시 불러오기"}</Button> : <>
            {!data.canWrite ? <p>읽기 권한으로 열었어요. 저장한 문안을 확인하고 복사할 수 있어요.</p> : null}
            {data.sections.length === 0 ? <p>이 양식에서 확인된 서술형 문항이 아직 없어요. 양식 준비 상태를 확인하거나 문서에서 직접 작성해 주세요.</p> : null}
            {data.sections.length ? <>
              <Button variant="outline" disabled={busy || dirty} onClick={() => void run(async () => { await refresh(); setShowChecks(true); })}>저장 문안의 사업명·수치 점검</Button>
              {dirty ? <p className="text-sm text-muted-foreground">문안 변경을 저장한 뒤 점검할 수 있어요.</p> : null}
              {showChecks && data.consistency ? <Card variant="workspace"><CardHeader><CardTitle>저장 문안 점검</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">보관한 문안 {data.consistency.checkedSections}개와 사업 설명에서 ‘항목: 값’으로 명시한 내용을 대조했어요. 실제 양식 파일의 전체 내용과 자유 문장의 의미는 별도로 검토해 주세요.</p>
                {data.consistency.issues.length ? data.consistency.issues.map((issue, index) => <div key={index}>
                  <p>{issue.message}</p>
                  <ul className="list-disc pl-5">{issue.entries.map((entry, i) => <li key={i}>{entry.label}: {entry.value}</li>)}</ul>
                </div>) : <p>인식한 수치 항목 {data.consistency.recognizedValues}개와 명시된 사업명·기간에서 대조 가능한 불일치를 찾지 못했어요. 모든 내용의 정확성을 확인한 결과는 아닙니다.</p>}
              </CardContent></Card> : null}
            </> : null}
            {section && editor ? <>
              <Field><FieldLabel htmlFor="writing-section-choice">작성할 문항</FieldLabel>
                <Select value={fieldId} disabled={busy} items={data.sections.map(section => ({ value: section.fieldId, label: section.label }))}
                  onValueChange={id => { setFieldId(id); if (id) onSelectField?.(id); setApplication(null); setCompare(false); setError(null); setNotice(null); }}>
                  <SelectTrigger id="writing-section-choice"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{data.sections.map(section => <SelectItem key={section.fieldId} value={section.fieldId}>{section.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                {section.guidance ? <FieldDescription>{section.guidance}</FieldDescription> : null}
                {!section.available ? <FieldDescription>현재 양식에서 이 문항을 확인하지 못했어요. 기존 문안은 보관되어 있으며 직접 수정·복사할 수 있어요.</FieldDescription> : null}
              </Field>
              <Field><FieldLabel htmlFor="writing-section-text">검토·수정할 문안</FieldLabel>
                <Textarea id="writing-section-text" rows={12} maxLength={12000} value={editor.text} disabled={busy || !data.canWrite} onChange={event => changeText(event.target.value)} />
                <FieldDescription>{editor.text.length.toLocaleString()} / 12,000자 · {changed ? "저장하지 않은 변경 있음" : `문안 저장본 ${editor.revision}`} · 문안 보관과 양식 파일 저장은 별개예요.</FieldDescription>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !data.canWrite || !changed} onClick={() => void run(async () => { await save(); setNotice("문안을 저장했어요. 양식 파일에 자동 반영되지는 않습니다."); })}>문안 저장</Button>
                <Button variant="outline" disabled={busy || !editor.text} onClick={() => void run(async () => { await navigator.clipboard.writeText(editor.text); setNotice("문안을 복사했어요. 양식의 해당 문항에 붙여 넣은 뒤 파일을 저장해 주세요."); })}>문안 복사</Button>
                <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await refresh(); setCompare(true); })}>최신 저장본·결과 확인</Button>
              </div>
              {compare ? <Field><FieldLabel htmlFor="writing-section-latest">최신 저장본 · 버전 {section.revision}</FieldLabel>
                <Textarea id="writing-section-latest" readOnly value={section.text} rows={6} />
                <Button variant="outline" disabled={busy} onClick={() => {
                  setEditors(current => ({ ...current, [section.fieldId]: { text: section.text, savedText: section.text, revision: section.revision } })); setCompare(false);
                }}>현재 입력을 최신 저장본으로 바꾸기</Button>
                <Button variant="outline" disabled={busy || !data.canWrite} onClick={() => {
                  setEditors(current => ({ ...current, [section.fieldId]: { ...editor, savedText: section.text, revision: section.revision } })); setCompare(false);
                  setNotice("현재 입력을 유지했어요. 비교·수정한 내용을 다시 저장해 주세요.");
                }}>현재 입력 유지하고 저장 기준 갱신</Button>
              </Field> : null}
              <Alert><AlertDescription>문안 저장 → 입력 위치 확인·양식 반영 → 파일 저장. 문안만 저장하면 원본 양식은 바뀌지 않아요.</AlertDescription></Alert>
              {inspectField && applySavedText && data.canWrite && section.available ? <Button variant="outline" disabled={busy || Boolean(changed) || !editor.savedText || editor.savedText.length > 4_000} onClick={() => void run(async () => {
                const binding = await inspectField(section.fieldId, editor.savedText);
                if (!binding) { setApplication(null); setNotice("안전하게 반영할 입력 위치를 확인하지 못했어요. 문안을 복사해 원본 양식에서 직접 작성해 주세요."); return; }
                setApplication({ fieldId: section.fieldId, beforeText: binding.beforeText, text: editor.savedText, revision: editor.revision, requiresConfirmation: Boolean(binding.requiresConfirmation), confirmed: false });
              })}>저장 문안과 양식 비교</Button> : null}
              {inspectField && editor.savedText.length > 4_000 ? <p className="text-xs text-muted-foreground">4,000자를 넘는 문안은 복사해 원본 양식에서 직접 작성해 주세요.</p> : null}
              {application && application.fieldId === fieldId ? <Card variant="workspace"><CardHeader><CardTitle>이 문항에 반영할 내용</CardTitle><CardDescription>확인된 입력 칸 하나에 저장 문안을 넣어요. 현재 내용과 저장 문안을 비교해 주세요.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">
                <div><p className="text-xs text-muted-foreground">양식의 현재 내용</p><p className="whitespace-pre-wrap break-words text-sm">{application.beforeText || "비어 있음"}</p></div>
                <div><p className="text-xs text-muted-foreground">저장 문안 · 버전 {application.revision}</p><p className="whitespace-pre-wrap break-words text-sm">{application.text}</p></div>
                {application.requiresConfirmation ? <label htmlFor="writing-overwrite-confirmation" className="flex items-start gap-2 text-sm"><Checkbox id="writing-overwrite-confirmation" checked={application.confirmed} disabled={busy} onCheckedChange={value => setApplication(current => current ? { ...current, confirmed: value === true } : null)} />현재 내용을 검토했으며 저장 문안으로 바꾸겠습니다</label> : null}
                <Button disabled={busy || Boolean(changed) || editor.revision !== application.revision || (application.requiresConfirmation && !application.confirmed)} onClick={() => void run(async () => {
                  const latest = await request<WritingSections>(endpoint);
                  const saved = latest.sections.find(item => item.fieldId === application.fieldId);
                  const binding = await inspectField!(application.fieldId, application.text);
                  try { assertWritingApplicationCurrent(application, saved, latest.canWrite, binding); } catch (error) { setApplication(null); throw error; }
                  await applySavedText!(application.fieldId, application.text, { beforeText: application.beforeText, overwriteConfirmed: application.requiresConfirmation && application.confirmed }); setApplication(null);
                  setNotice("저장 문안을 확인된 양식 입력 칸에 반영했어요. 상단에서 파일 저장 상태를 확인해 주세요.");
                })}>이 칸에 반영</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setApplication(null)}>비교 닫기</Button>
              </CardContent></Card> : null}
              {data.canGenerate && section.available ? <Button disabled={busy || suggestion?.status === "running"} onClick={() => void run(async () => {
                const revision = await save();
                if (pending.current?.fieldId !== fieldId || pending.current.revision !== revision) pending.current = { fieldId: section.fieldId, revision, requestId: crypto.randomUUID() };
                const result = await request<WritingSections>(endpoint, { method: "POST", body: JSON.stringify({ fieldId, expectedRevision: revision, requestId: pending.current.requestId }) });
                receive(result);
                if (result.sections.find(item => item.fieldId === fieldId)?.proposal?.status !== "running") pending.current = null;
              })}>{busy ? "처리 중…" : "저장한 자료와 문안으로 초안 요청"}</Button> : null}
              {suggestion ? <Card variant="workspace"><CardHeader><CardTitle>검토용 초안</CardTitle>
                {suggestion.composition ? <CardDescription>선택한 회사 자료와 이번 사업 설명을 바탕으로 작성한 검토용 초안입니다. 문단마다 출처 종류를 표시해요.</CardDescription> : null}
              </CardHeader><CardContent className="flex flex-col gap-3">
                {suggestion.status === "running" ? <p role="status">초안을 작성 중이에요. 잠시 뒤 최신 결과를 확인해 주세요.</p> : null}
                {suggestion.message ? <p role="status">{suggestion.message}</p> : null}
                {suggestion.composition ? <>
                  {suggestion.composition.paragraphs.map((paragraph, index) => <div key={index}>
                    <p className="text-sm text-muted-foreground">{writingParagraphKindLabels[paragraph.kind]}</p>
                    <p className="whitespace-pre-wrap">{paragraph.text}</p>
                    {paragraph.kind === "proposal" ? <p className="text-xs text-muted-foreground">아직 확정하지 않은 아이디어입니다. 실행 가능성을 검토해 주세요.</p> : null}
                  </div>)}
                  {evidenceCount ? <details><summary>인용 근거 보기 · {evidenceCount}건</summary>
                    <ul className="mt-2 flex flex-col gap-2">{suggestion.composition.paragraphs.flatMap((paragraph, index) => paragraph.evidence.map((evidence, i) => <li key={`${index}-${i}`}>
                      <p className="text-xs text-muted-foreground">{writingParagraphKindLabels[paragraph.kind]}</p>
                      <blockquote className="whitespace-pre-wrap border-l pl-3">{evidence.quote}</blockquote>
                    </li>))}</ul>
                  </details> : null}
                  {suggestion.composition.questions.length ? <div>
                    <p>보완할 내용 · {suggestion.composition.questions.length}</p>
                    <ol className="list-decimal pl-5">{suggestion.composition.questions.map(question => <li key={question}>{question}</li>)}</ol>
                    <p className="text-xs text-muted-foreground">질문은 사업 설명에 답을 적어 저장하면 다음 초안에 반영돼요. 건너뛰어도 초안을 가져올 수 있어요.</p>
                  </div> : null}
                  <Button variant="outline" disabled={busy || !data.canWrite || !proposalIsCurrent || !suggestion.composition.paragraphs.length} onClick={() => {
                    changeText(writingCompositionText(suggestion.composition!)); setNotice("초안을 편집 칸에 가져왔어요. 검토·수정한 뒤 문안을 저장해 주세요.");
                  }}>초안을 편집 칸으로 가져오기</Button>
                  {changed ? <p className="text-sm text-muted-foreground">현재 입력을 먼저 저장한 뒤 초안을 다시 요청해 주세요.</p> : null}
                </> : null}
              </CardContent></Card> : null}
            </> : null}
          </>}
        </div>;
  if (presentation === "inline") return <Card variant="workspace" data-writing-panel className="min-w-0">
    <CardHeader><CardTitle>문항 작성</CardTitle><CardDescription>양식을 보며 직접 문안을 쓰고, 저장한 문안을 검토해 반영해요.</CardDescription></CardHeader>
    <CardContent>{content}</CardContent>
  </Card>;
  return <>
    <Button variant="outline" size="sm" onClick={() => { setOpen(true); if (!data) void run(refresh); }}>문항별 문안{dirty ? " · 저장 필요" : ""}</Button>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader><SheetTitle>문항별 문안 작성</SheetTitle><SheetDescription>저장한 문안을 검토해 양식에 반영해 주세요.</SheetDescription></SheetHeader>
        <div className="p-4">{content}</div>
      </SheetContent>
    </Sheet>
  </>;
}

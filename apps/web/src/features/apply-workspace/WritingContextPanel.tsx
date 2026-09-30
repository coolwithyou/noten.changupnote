"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ActionResult } from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { companyScopedFetch } from "@/lib/navigation/companyContext";
import { emptyWritingBrief, writingBriefFields, WRITING_PDF_MAX_BYTES, type WritingBrief, type WritingContext, type WritingSourceSummary } from "@/lib/documents/writingContext";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await companyScopedFetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const result = await response.json() as ActionResult<T>;
  if (!result.ok || !result.data) throw new Error(result.error?.message ?? "요청을 처리하지 못했습니다.");
  return result.data;
}

/** 닫아도 입력 상태를 유지하며, 다른 draft에서는 key로 완전히 분리한다. */
export function WritingContextPanel({ draftId, onDirtyChange }: { draftId: string; onDirtyChange: (dirty: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<WritingContext | null>(null);
  const [brief, setBrief] = useState<WritingBrief>(emptyWritingBrief);
  const [selected, setSelected] = useState<string[]>([]);
  const [latest, setLatest] = useState<WritingContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [reusable, setReusable] = useState(false);
  const [documentSource, setDocumentSource] = useState(false);
  const [observedDate, setObservedDate] = useState("");
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const sourceRequest = useRef<{ signature: string; requestId: string } | null>(null);
  const endpoint = `/api/web/document-drafts/${encodeURIComponent(draftId)}`;
  const briefDirty = context !== null && (JSON.stringify(brief) !== JSON.stringify(context.brief) || JSON.stringify(selected) !== JSON.stringify(context.sourceIds));
  const dirty = briefDirty || Boolean(title || content || observedDate || pdfFile);
  const disabled = busy || !context?.canWrite;

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function acceptContext(value: WritingContext) {
    setContext(value); setBrief(value.brief); setSelected(value.sourceIds); setLatest(null);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function load() { acceptContext(await request<WritingContext>(`${endpoint}/writing-brief`)); }

  return <>
    <Button variant="outline" size="sm" onClick={() => { setOpen(true); if (!context) void run(load); }}>
      회사 자료·사업 설명{dirty ? " · 저장 필요" : ""}
    </Button>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>회사 자료와 이번 사업 설명</SheetTitle>
          <SheetDescription>기존 자료를 연결하고 이번 사업의 계획을 정리해요. 입력하지 않은 내용은 나중에 작성할 수 있어요.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-4">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {!context ? <Button variant="outline" disabled={busy} onClick={() => void run(load)}>{busy ? "불러오는 중…" : "다시 불러오기"}</Button> : <>
            {!context.canWrite ? <Alert><AlertDescription>읽기 권한으로 열었어요. 자료와 사업 설명을 수정할 수 없습니다.</AlertDescription></Alert> : null}
            <Card variant="workspace">
              <CardHeader><CardTitle>이번 문서에서 사용할 자료</CardTitle><CardDescription>선택한 자료는 문안 초안의 인용 근거로만 써요. 확인 전 회사 사실로 확정하지 않아요. 최대 10개, 합계 60,000자까지 선택할 수 있어요.</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-4">
                {context.sources.length === 0 ? <p>저장한 자료가 없어요. 아래에서 첫 자료를 추가해 주세요.</p> : <FieldGroup>
                  {context.sources.map((source) => <Field key={source.id}>
                    <Field orientation="horizontal">
                      <Checkbox id={`source-${source.id}`} checked={selected.includes(source.id)}
                        disabled={disabled || (source.withdrawn && !selected.includes(source.id)) || (!selected.includes(source.id) && selected.length >= 10)}
                        onCheckedChange={(checked) => setSelected((ids) => checked ? [...ids, source.id] : ids.filter((id) => id !== source.id))} />
                      <FieldLabel htmlFor={`source-${source.id}`}>{source.title}{source.withdrawn ? " · 사용 중단됨" : ""}</FieldLabel>
                    </Field>
                    <FieldDescription>{source.scope === "company" ? "회사 공통 자료" : "이번 신청 전용"} · {source.observedDate ? `${source.observedDate} 기준` : "기준일 미입력"}{source.originalPdf ? ` · PDF ${source.originalPdf.pages}쪽` : ""}{source.withdrawn ? " · 이후 초안 생성에 전달되지 않아요. 이미 저장한 문서 내용은 유지됩니다." : ""}</FieldDescription>
                    {!source.withdrawn ? <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => setPreview(await request(`${endpoint}/writing-sources/${source.id}`)))}>내용 보기</Button>
                      {source.originalPdf ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => {
                        const response = await companyScopedFetch(`${endpoint}/writing-sources/${source.id}/original`);
                        if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message ?? "원본을 내려받지 못했습니다."); }
                        const url = URL.createObjectURL(await response.blob());
                        const link = document.createElement("a"); link.href = url; link.download = source.originalPdf!.filename; link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      })}>PDF 원본</Button> : null}
                      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void run(async () => {
                        await request(`${endpoint}/writing-sources/${source.id}`, { method: "DELETE" });
                        setContext((value) => value ? { ...value, sources: value.sources.map((item) => item.id === source.id ? { ...item, withdrawn: true } : item) } : value);
                        setSelected((ids) => ids.filter((id) => id !== source.id)); setPreview(null);
                        setNotice("자료 사용을 중단했어요. 이미 저장한 문서 내용은 유지됩니다. 자료 선택 변경도 저장해 주세요.");
                      })}>자료 사용 중단</Button>
                    </div> : null}
                  </Field>)}
                </FieldGroup>}
                <p className="text-xs text-muted-foreground">{context.sourcesTruncated ? "최근 자료 200개와 이 문서에서 선택한 자료를 표시합니다. " : null}<Link href="/settings/writing-sources" className="font-medium underline underline-offset-4">회사 공통 자료 관리 →</Link></p>
                {preview ? <Field><FieldLabel htmlFor="writing-source-preview">{preview.title}</FieldLabel><Textarea id="writing-source-preview" readOnly value={preview.content} rows={8} /><Button variant="ghost" size="sm" onClick={() => setPreview(null)}>내용 닫기</Button></Field> : null}
              </CardContent>
            </Card>
            <Card variant="workspace">
              <CardHeader><CardTitle>자료 추가</CardTitle><CardDescription>회사 소개·과거 계획서 내용을 붙여 넣거나 PDF를 올려요. 수정할 때는 새 자료로 등록해 출처를 보존합니다.</CardDescription></CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field><FieldLabel htmlFor="writing-source-title">자료 이름</FieldLabel><Input id="writing-source-title" value={title} maxLength={200} disabled={disabled} onChange={(event) => setTitle(event.target.value)} /></Field>
                  <Field><FieldLabel htmlFor="writing-source-pdf">PDF 파일 · 선택</FieldLabel>
                    <Input key={fileInputKey} id="writing-source-pdf" type="file" accept="application/pdf,.pdf" disabled={disabled || !context.canUploadPdf || Boolean(content)} onChange={event => {
                      const file = event.target.files?.[0] ?? null;
                      if (file && (file.size > WRITING_PDF_MAX_BYTES || !/\.pdf$/i.test(file.name))) { setError("4MB 이내의 PDF 파일을 선택해 주세요."); event.target.value = ""; setPdfFile(null); return; }
                      setPdfFile(file); if (file && !title) setTitle(file.name.slice(0, 200));
                    }} />
                    <FieldDescription>최대 4MB·30쪽·추출 텍스트 30,000자. 스캔·암호 PDF는 지원하지 않아요. PDF를 고르면 아래 자료 내용은 비활성화돼요.</FieldDescription>
                    {!context.canUploadPdf && context.canWrite ? <FieldDescription>PDF 업로드는 현재 사용할 수 없어요. 필요한 내용을 아래에 붙여 넣을 수 있어요.</FieldDescription> : null}
                    {pdfFile ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPdfFile(null); setFileInputKey(key => key + 1); }}>파일 선택 취소</Button> : null}
                  </Field>
                  <Field><FieldLabel htmlFor="writing-source-content">자료 내용</FieldLabel><Textarea id="writing-source-content" value={content} maxLength={30000} rows={6} placeholder="PDF 대신 내용을 직접 붙여 넣을 수 있어요 · 최대 30,000자" disabled={disabled || Boolean(pdfFile)} onChange={(event) => setContent(event.target.value)} /><FieldDescription>사실과 목표를 구분하고 과거 실적에는 연도를 적어 주세요.</FieldDescription></Field>
                  <Field><FieldLabel htmlFor="writing-source-date">자료 기준일 · 선택</FieldLabel><Input id="writing-source-date" type="date" value={observedDate} disabled={disabled} onChange={(event) => setObservedDate(event.target.value)} /></Field>
                  <Field orientation="horizontal"><Checkbox id="writing-source-document" checked={documentSource || Boolean(pdfFile)} disabled={disabled || Boolean(pdfFile)} onCheckedChange={(checked) => setDocumentSource(Boolean(checked))} /><FieldLabel htmlFor="writing-source-document">기존 회사 문서에서 가져온 내용이에요</FieldLabel></Field>
                  <Field orientation="horizontal"><Checkbox id="writing-source-reusable" checked={reusable} disabled={disabled} onCheckedChange={(checked) => setReusable(Boolean(checked))} /><FieldLabel htmlFor="writing-source-reusable">다른 공고에서도 사용할 회사 공통 자료로 저장</FieldLabel></Field>
                  <Button disabled={disabled || !title.trim() || (!content.trim() && !pdfFile)} onClick={() => void run(async () => {
                    const body = { title, content, scope: reusable ? "company" : "application", kind: documentSource ? "company_document" : "user_statement", observedDate: observedDate || null };
                    const bytes = pdfFile ? await pdfFile.arrayBuffer() : null;
                    const fileSha = bytes ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("") : null;
                    const signature = JSON.stringify({ ...body, filename: pdfFile?.name, fileSha });
                    if (sourceRequest.current?.signature !== signature) sourceRequest.current = { signature, requestId: crypto.randomUUID() };
                    let source: WritingSourceSummary;
                    if (pdfFile) {
                      const form = new FormData(); form.set("file", pdfFile);
                      form.set("metadata", JSON.stringify({ requestId: sourceRequest.current.requestId, title, scope: body.scope, observedDate: body.observedDate }));
                      const response = await companyScopedFetch(`${endpoint}/writing-sources/pdf`, { method: "POST", body: form });
                      const result = await response.json() as ActionResult<WritingSourceSummary>;
                      if (!result.ok || !result.data) throw new Error(result.error?.message ?? "PDF 자료를 저장하지 못했습니다.");
                      source = result.data;
                    } else source = await request<WritingSourceSummary>(`${endpoint}/writing-sources`, { method: "POST", body: JSON.stringify({ ...body, requestId: sourceRequest.current.requestId }) });
                    setContext((value) => value ? { ...value, sources: [source, ...value.sources.filter((item) => item.id !== source.id)] } : value);
                    if (!source.withdrawn && !pdfFile) setSelected((ids) => ids.includes(source.id) || ids.length >= 10 ? ids : [...ids, source.id]);
                    setTitle(""); setContent(""); setObservedDate(""); sourceRequest.current = null;
                    setPdfFile(null); setFileInputKey(key => key + 1);
                    setNotice(pdfFile ? "PDF를 보관했어요. 내용 보기에서 추출한 내용을 확인한 뒤 자료를 선택해 주세요." : "자료를 저장했어요. 이 문서의 자료 선택과 사업 설명도 저장해 주세요.");
                  })}>{pdfFile ? "PDF 추출·보관" : "자료 저장"}</Button>
                </FieldGroup>
              </CardContent>
            </Card>
            <Card variant="workspace">
              <CardHeader><CardTitle>이번 사업 설명</CardTitle><CardDescription>회사의 과거 사실이 아니라 이번 공고에서 하려는 일이에요. 모르는 항목은 비워 두세요.</CardDescription></CardHeader>
              <CardContent>
                <FieldGroup>
                  {(Object.keys(writingBriefFields) as (keyof WritingBrief)[]).map((key) => <Field key={key}>
                    <FieldLabel htmlFor={`writing-brief-${key}`}>{writingBriefFields[key]}</FieldLabel>
                    <Textarea id={`writing-brief-${key}`} value={brief[key]} maxLength={key === "projectName" ? 200 : 3000} rows={key === "projectName" ? 2 : 3} disabled={disabled} onChange={(event) => setBrief((value) => ({ ...value, [key]: event.target.value }))} />
                  </Field>)}
                  <Button disabled={disabled || !briefDirty} onClick={() => void run(async () => {
                    acceptContext(await request<WritingContext>(`${endpoint}/writing-brief`, { method: "PUT", body: JSON.stringify({ expectedRevision: context.revision, brief, sourceIds: selected }) }));
                    setNotice("자료 선택과 이번 사업 설명을 저장했어요.");
                  })}>{busy ? "처리 중…" : "자료 선택·사업 설명 저장"}</Button>
                  <Button variant="outline" disabled={busy} onClick={() => void run(async () => setLatest(await request<WritingContext>(`${endpoint}/writing-brief`)))}>최신 저장본 비교</Button>
                  {latest ? <Field>
                    <FieldLabel htmlFor="writing-latest-brief">최신 저장본 · 버전 {latest.revision}</FieldLabel>
                    <Textarea id="writing-latest-brief" readOnly rows={8} value={(Object.keys(writingBriefFields) as (keyof WritingBrief)[]).map((key) => `${writingBriefFields[key]}\n${latest.brief[key] || "미입력"}`).join("\n\n")} />
                    <FieldDescription>자료 선택: {latest.sources.filter((source) => latest.sourceIds.includes(source.id)).map((source) => source.title).join(", ") || "없음"}. 현재 입력은 그대로 보존되어 있어요.</FieldDescription>
                    <Button variant="outline" disabled={busy} onClick={() => { acceptContext(latest); setNotice("현재 입력을 최신 저장본으로 바꿨어요."); }}>현재 입력을 최신 저장본으로 바꾸기</Button>
                    <Button variant="outline" disabled={busy || !latest.canWrite} onClick={() => { setContext(latest); setLatest(null); setNotice("현재 입력을 유지했어요. 내용을 대조·수정한 뒤 다시 저장해 주세요."); }}>현재 입력 유지하고 저장 기준 갱신</Button>
                  </Field> : null}
                </FieldGroup>
              </CardContent>
            </Card>
          </>}
        </div>
      </SheetContent>
    </Sheet>
  </>;
}

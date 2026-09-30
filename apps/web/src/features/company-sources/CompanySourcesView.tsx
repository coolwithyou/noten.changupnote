"use client";

import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { WRITING_PDF_MAX_BYTES, type WritingSourceSummary } from "@/lib/documents/writingContext";
import type { CompanyWritingSourceRow, CompanyWritingSources } from "@/lib/server/documents/companyWritingSources";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { COMPANY_SOURCES_COPY as C, sourceCountLabel, sourceMetaLine, sourceScopeLabel, workspaceHrefFor } from "./presentation";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result = await response.json() as ActionResult<T>;
  if (!response.ok || !result.ok || result.data === undefined) throw new Error(result.error?.message ?? "요청을 처리하지 못했습니다.");
  return result.data;
}

const sha256Hex = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * 설정 › 회사 자료(디자인 04). 회사 공통 자료를 추가·열람·사용 중단하고, 이번 신청 전용 자료는 관리 위치만 안내한다.
 * 서버 페이지가 첫 목록을 넘기고, 변경 뒤에는 목록을 다시 받아 사용 중인 문서 수를 최신으로 유지한다.
 */
export function CompanySourcesView({ companyId, initial, loadError }: { companyId: string; initial: CompanyWritingSources | null; loadError: string | null }) {
  const endpoint = `/api/web/companies/${encodeURIComponent(companyId)}/writing-sources`;
  const [data, setData] = useState<CompanyWritingSources | null>(initial);
  const [error, setError] = useState<string | null>(loadError);
  const [notice, setNotice] = useState<{ title: string; body?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [observedDate, setObservedDate] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [documentSource, setDocumentSource] = useState(false);
  const sourceRequest = useRef<{ signature: string; requestId: string } | null>(null);

  const canWrite = Boolean(data?.canWrite);
  const disabled = busy || !canWrite;
  const confirmTarget = confirmId ? data?.sources.find((row) => row.id === confirmId) ?? null : null;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function reload() { setData(await requestJson<CompanyWritingSources>(endpoint)); }

  async function toggleContent(row: CompanyWritingSourceRow, next: boolean) {
    setOpenIds((prev) => { const ids = new Set(prev); if (next) ids.add(row.id); else ids.delete(row.id); return ids; });
    if (!next || contents[row.id] !== undefined) return;
    setLoadingId(row.id);
    try {
      const source = await requestJson<WritingSourceSummary & { content: string }>(`${endpoint}/${encodeURIComponent(row.id)}`);
      setContents((prev) => ({ ...prev, [row.id]: source.content }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "자료를 불러오지 못했습니다.");
      setOpenIds((prev) => { const ids = new Set(prev); ids.delete(row.id); return ids; });
    } finally { setLoadingId(null); }
  }

  async function downloadPdf(row: CompanyWritingSourceRow) {
    const response = await fetch(`${endpoint}/${encodeURIComponent(row.id)}/original`);
    if (!response.ok) {
      const result = await response.json().catch(() => null) as ActionResult<never> | null;
      throw new Error(result?.error?.message ?? "원본을 내려받지 못했습니다.");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = row.originalPdf?.filename ?? "original.pdf"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function withdraw(sourceId: string) {
    await requestJson(`${endpoint}/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
    await reload();
    toast(C.toastStopped);
  }

  async function save() {
    const body = { title, content, kind: documentSource || pdfFile ? "company_document" : "user_statement", observedDate: observedDate || null };
    const bytes = pdfFile ? await pdfFile.arrayBuffer() : null;
    const signature = JSON.stringify({ ...body, filename: pdfFile?.name, fileSha: bytes ? await sha256Hex(bytes) : null });
    if (sourceRequest.current?.signature !== signature) sourceRequest.current = { signature, requestId: crypto.randomUUID() };
    const requestId = sourceRequest.current.requestId;
    const wasPdf = Boolean(pdfFile);
    if (pdfFile) {
      const form = new FormData(); form.set("file", pdfFile);
      form.set("metadata", JSON.stringify({ requestId, title, observedDate: body.observedDate }));
      await requestJson<WritingSourceSummary>(`${endpoint}/pdf`, { method: "POST", body: form });
    } else {
      await requestJson<WritingSourceSummary>(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, requestId }) });
    }
    setTitle(""); setContent(""); setObservedDate(""); setDocumentSource(false); sourceRequest.current = null;
    setPdfFile(null); setFileInputKey((key) => key + 1);
    await reload();
    setNotice(wasPdf ? { title: C.pdfSaved, body: C.pdfSavedBody } : { title: C.textSaved });
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* 스크롤 불가 환경은 무시 */ }
  }

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 py-10 sm:px-0 sm:py-14">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-extrabold tracking-tight">{C.title}</h1>
          <p className="text-[13px] text-text-tertiary">{C.caption}</p>
        </div>
        <a href="#add" className={cn(buttonVariants({ size: "sm" }))}>{C.addAction}</a>
      </div>

      {notice ? (
        <Alert className="border-border-mint-soft bg-surface-mint">
          <AlertTitle>{notice.title}</AlertTitle>
          {notice.body ? <AlertDescription>{notice.body}</AlertDescription> : null}
          <AlertAction><Button variant="ghost" size="xs" onClick={() => setNotice(null)}>닫기</Button></AlertAction>
        </Alert>
      ) : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <Alert>
        <AlertTitle>{C.calloutTitle}</AlertTitle>
        <AlertDescription>{C.calloutBody}</AlertDescription>
      </Alert>
      {data && !data.canWrite && data.readOnlyReason ? <Alert><AlertDescription>{data.readOnlyReason}</AlertDescription></Alert> : null}

      {data === null ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle className="text-base font-extrabold">회사 자료를 불러오지 못했어요.</EmptyTitle>
            {loadError ? <EmptyDescription>{loadError}</EmptyDescription> : null}
          </EmptyHeader>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(reload)}>다시 불러오기</Button>
        </Empty>
      ) : data.sources.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle className="text-base font-extrabold">{C.emptyTitle}</EmptyTitle>
            <EmptyDescription>{C.emptyBody}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card variant="workspace" className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-lg font-extrabold">{C.listTitle}</CardTitle>
            <CardAction><span className="text-xs tabular-nums text-text-tertiary">{sourceCountLabel(data.sources)}</span></CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {data.sources.map((row, index) => (
              <div key={row.id}>
                {index > 0 ? <Separator className="bg-border-subtle" /> : null}
                <SourceRow
                  row={row}
                  companyId={companyId}
                  open={openIds.has(row.id)}
                  content={contents[row.id]}
                  loading={loadingId === row.id}
                  busy={busy}
                  canWrite={canWrite}
                  onToggle={(next) => void toggleContent(row, next)}
                  onDownload={() => void run(() => downloadPdf(row))}
                  onStop={() => setConfirmId(row.id)}
                />
              </div>
            ))}
            {data.sourcesTruncated ? <p className="px-5 py-3 text-xs text-text-tertiary">{C.truncated}</p> : null}
          </CardContent>
        </Card>
      )}

      <Card variant="workspace" id="add" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="text-lg font-extrabold">{C.addTitle}</CardTitle>
          <CardDescription>{C.addCaption}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="company-source-title">{C.fieldTitle}</FieldLabel>
              <Input id="company-source-title" value={title} maxLength={200} placeholder={C.fieldTitlePlaceholder} disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="company-source-pdf">{C.fieldPdf}</FieldLabel>
              <Input key={fileInputKey} id="company-source-pdf" type="file" accept="application/pdf,.pdf" disabled={disabled || !data?.canUploadPdf || Boolean(content)} onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (file && (file.size > WRITING_PDF_MAX_BYTES || !/\.pdf$/i.test(file.name))) { setError("4MB 이내의 PDF 파일을 선택해 주세요."); event.target.value = ""; setPdfFile(null); return; }
                setPdfFile(file); if (file && !title) setTitle(file.name.slice(0, 200));
              }} />
              <FieldDescription>{C.fieldPdfHint}</FieldDescription>
              {data && canWrite && !data.canUploadPdf ? <FieldDescription>{C.pdfUnavailable}</FieldDescription> : null}
              {pdfFile ? <Button variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => { setPdfFile(null); setFileInputKey((key) => key + 1); }}>파일 선택 취소</Button> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="company-source-content">{C.fieldContent}</FieldLabel>
              <Textarea id="company-source-content" value={content} maxLength={30000} rows={6} placeholder={C.fieldContentPlaceholder} disabled={disabled || Boolean(pdfFile)} onChange={(event) => setContent(event.target.value)} />
              <FieldDescription>{C.fieldContentHint}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="company-source-date">{C.fieldDate}</FieldLabel>
              <Input id="company-source-date" type="date" className="sm:w-[180px]" value={observedDate} disabled={disabled} onChange={(event) => setObservedDate(event.target.value)} />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="company-source-document" checked={documentSource || Boolean(pdfFile)} disabled={disabled || Boolean(pdfFile)} onCheckedChange={(checked) => setDocumentSource(Boolean(checked))} />
              <FieldLabel htmlFor="company-source-document">{C.checkFromDocument}</FieldLabel>
            </Field>
            <Field orientation="horizontal" data-disabled>
              <Checkbox id="company-source-reusable" checked disabled />
              <FieldLabel htmlFor="company-source-reusable">{C.checkReusable}</FieldLabel>
            </Field>
            <FieldDescription>{C.checkReusableHint}</FieldDescription>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={disabled || !title.trim() || (!content.trim() && !pdfFile)} onClick={() => void run(save)}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {pdfFile ? C.savePdf : C.saveText}
              </Button>
              <span className="text-xs text-text-tertiary">{C.saveHint}</span>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <p className="text-[13px] text-text-tertiary">{C.footer}</p>

      <AlertDialog open={confirmId !== null} onOpenChange={(open) => { if (!open) setConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{C.confirmStopTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmTarget ? `${confirmTarget.title} · ` : ""}{C.confirmStopBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{C.confirmCancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
              const id = confirmId; setConfirmId(null);
              if (id) void run(() => withdraw(id));
            }}>{C.stopUsing}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SourceRow({ row, companyId, open, content, loading, busy, canWrite, onToggle, onDownload, onStop }: {
  row: CompanyWritingSourceRow; companyId: string; open: boolean; content: string | undefined; loading: boolean; busy: boolean; canWrite: boolean;
  onToggle: (next: boolean) => void; onDownload: () => void; onStop: () => void;
}) {
  const pdf = Boolean(row.originalPdf);
  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <div className={cn("flex flex-col gap-3 px-5 py-4", row.withdrawn && "opacity-60")}>
        <div className="flex flex-wrap items-start gap-3.5">
          <span aria-hidden className={cn("flex h-10 w-[34px] flex-none items-center justify-center rounded-[7px] border text-[10px] font-extrabold",
            pdf ? "border-transparent bg-danger-soft text-danger" : "border-border-muted bg-surface-soft text-text-tertiary")}>{pdf ? "PDF" : "TXT"}</span>
          <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] leading-snug font-extrabold break-all text-ink-strong">{row.title}</span>
              <Badge variant="outline" size="admin">{sourceScopeLabel(row.scope)}</Badge>
            </div>
            <span className="text-[12.5px] text-text-secondary">{sourceMetaLine(row)}</span>
            <div className="flex flex-wrap items-center gap-2">
              {row.withdrawn ? <Badge size="admin" className="bg-surface-muted text-text-tertiary">{C.statusWithdrawn}</Badge> : (
                <>
                  <Badge size="admin" className="bg-brand-mint-soft text-brand-mint-ink">{C.statusAvailable}</Badge>
                  <span className="text-xs text-text-tertiary">{C.statusAvailableCaption}</span>
                </>
              )}
            </div>
            {row.kind === "company_document" ? (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-brand-mint-ink"><Check className="size-3.5" aria-hidden />{C.fromDocument}</span>
            ) : null}
            {row.application ? (
              <span className="text-xs text-text-tertiary">
                {C.applicationCaption} · <a href={workspaceHrefFor(row.application, companyId)} className="font-bold text-primary underline-offset-4 hover:underline">{C.openWorkspace}</a>
              </span>
            ) : null}
          </div>
          <div className="flex flex-none flex-wrap items-center gap-1">
            <Button variant="link" size="sm" aria-expanded={open} disabled={loading} onClick={() => onToggle(!open)}>
              {loading ? <Spinner data-icon="inline-start" /> : null}
              {open ? C.closeContent : C.viewContent}
            </Button>
            {pdf ? <Button variant="link" size="sm" disabled={busy} onClick={onDownload}>{C.pdfOriginal}</Button> : null}
            {row.scope === "company" && !row.withdrawn ? <Button variant="link" size="sm" disabled={busy || !canWrite} onClick={onStop}>{C.stopUsing}</Button> : null}
          </div>
        </div>
        <CollapsibleContent>
          <div className="rounded-xl border border-border-subtle bg-surface-soft px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-line text-ink sm:ml-12">
            {content ?? "불러오는 중…"}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

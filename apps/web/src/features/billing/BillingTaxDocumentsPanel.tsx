"use client";

import { useRef, useState, type FormEvent } from "react";
import { ExternalLink, FileCheck2, Loader2, Trash2, UploadCloud } from "lucide-react";
import type { ActionResult } from "@cunote/contracts";
import type {
  BillingTaxDocumentArchiveResult,
  BillingTaxDocumentItem,
  BillingTaxDocumentKind,
  BillingTaxDocumentUploadResult,
} from "@/lib/server/billing/taxDocuments";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DOCUMENT_KIND_OPTIONS: Array<{ value: BillingTaxDocumentKind; label: string }> = [
  { value: "business_registration", label: "사업자등록증" },
  { value: "bank_account", label: "통장사본" },
  { value: "tax_invoice_certificate", label: "세금계산서 증빙" },
  { value: "other", label: "기타 청구 증빙" },
];

export function BillingTaxDocumentsPanel({
  initialDocuments,
  canUpdate,
}: {
  initialDocuments: BillingTaxDocumentItem[];
  canUpdate: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState(initialDocuments);
  const [documentKind, setDocumentKind] = useState<BillingTaxDocumentKind>("business_registration");
  const [pending, setPending] = useState(false);
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "warning" | "danger"; message: string } | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUpdate) return;
    const file = fileInputRef.current?.files?.[0] ?? null;
    if (!file) {
      setFeedback({ tone: "danger", message: "업로드할 파일을 선택해주세요." });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      formData.set("documentKind", documentKind);
      formData.set("file", file);
      const response = await fetch("/api/web/billing/tax-documents", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json() as ActionResult<BillingTaxDocumentUploadResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "청구 증빙 파일을 업로드하지 못했습니다.");
      }
      if (payload.data.document) {
        setDocuments((current) => [payload.data!.document!, ...current.filter((item) => item.id !== payload.data!.document!.id)]);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFeedback({
        tone: payload.data.persisted ? "success" : "warning",
        message: payload.data.message,
      });
    } catch (caught) {
      setFeedback({
        tone: "danger",
        message: caught instanceof Error ? caught.message : "청구 증빙 파일을 업로드하지 못했습니다.",
      });
    } finally {
      setPending(false);
    }
  }

  async function archiveDocument(document: BillingTaxDocumentItem) {
    if (!canUpdate) return;
    setPendingArchiveId(document.id);
    setFeedback(null);
    try {
      const response = await fetch(`/api/web/billing/tax-documents/${encodeURIComponent(document.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json() as ActionResult<BillingTaxDocumentArchiveResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "청구 증빙 파일을 보관 해제하지 못했습니다.");
      }
      if (payload.data.persisted) {
        setDocuments((current) => current.filter((item) => item.id !== document.id));
        setFeedback({ tone: "success", message: "청구 증빙 파일을 보관 해제했습니다." });
      } else {
        setFeedback({ tone: "warning", message: "DB 연결 전이라 보관 해제를 임시 응답으로 처리했습니다." });
      }
    } catch (caught) {
      setFeedback({
        tone: "danger",
        message: caught instanceof Error ? caught.message : "청구 증빙 파일을 보관 해제하지 못했습니다.",
      });
    } finally {
      setPendingArchiveId(null);
    }
  }

  return (
    <div className="grid gap-5" id="billing-tax-documents-panel">
      <form className="billing-plan-request-form" onSubmit={(event) => void upload(event)}>
        <FieldGroup>
          <div className="billing-request-grid two">
            <Field>
              <FieldLabel htmlFor="billing-tax-document-kind">문서 종류</FieldLabel>
              <Select value={documentKind} disabled={!canUpdate || pending} onValueChange={(value) => setDocumentKind(value as BillingTaxDocumentKind)}>
                <SelectTrigger id="billing-tax-document-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {DOCUMENT_KIND_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>세금계산서 발행과 내부 결재에 필요한 증빙을 구분합니다.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="billing-tax-document-file">파일</FieldLabel>
              <Input
                id="billing-tax-document-file"
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.hwp,.hwpx,.doc,.docx"
                disabled={!canUpdate || pending}
              />
              <FieldDescription>PDF, 이미지, HWP/HWPX, DOC/DOCX 파일을 10MB까지 보관합니다.</FieldDescription>
            </Field>
          </div>
        </FieldGroup>
        {feedback ? (
          <div className={`billing-request-feedback ${feedback.tone === "danger" ? "error" : "success"}`} role="status">
            {feedback.message}
          </div>
        ) : null}
        <Button type="submit" disabled={!canUpdate || pending}>
          {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <UploadCloud data-icon="inline-start" />}
          증빙 파일 보관
        </Button>
      </form>

      <div className="grid gap-3">
        {documents.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-4">
            <strong className="block text-sm font-extrabold text-foreground">보관된 청구 증빙 파일이 없습니다.</strong>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              사업자등록증이나 통장사본을 보관하면 유료 전환과 세금계산서 발행 준비 상태를 한곳에서 확인할 수 있습니다.
            </p>
          </div>
        ) : (
          documents.map((document) => (
            <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border p-4 md:grid-cols-[minmax(0,1fr)_auto]" key={document.id}>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <FileCheck2 className="size-4 text-muted-foreground" aria-hidden />
                  <strong className="text-sm font-extrabold text-foreground">{document.filename}</strong>
                  <StatusBadge tone="brand">{document.documentKindLabel}</StatusBadge>
                  <StatusBadge tone={document.status === "active" ? "success" : "neutral"}>{document.statusLabel}</StatusBadge>
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {document.sizeLabel} · {document.contentType} · sha256 {document.sha256.slice(0, 12)}
                </p>
                <span className="mt-2 block text-xs font-bold text-muted-foreground">
                  최근 업데이트 {formatDate(document.updatedAt)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <a className={buttonVariants({ variant: "outline" })} href={document.archiveUrl} rel="noreferrer" target="_blank">
                  <ExternalLink data-icon="inline-start" />
                  보관본
                </a>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void archiveDocument(document)}
                  disabled={!canUpdate || pendingArchiveId === document.id}
                >
                  {pendingArchiveId === document.id ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
                  해제
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

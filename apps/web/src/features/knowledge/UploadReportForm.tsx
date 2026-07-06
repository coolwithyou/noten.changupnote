"use client";

import { useRef, useState } from "react";
import { UploadCloud, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { KnowledgeSourceDto } from "@/lib/server/knowledge/knowledgeDashboardData";
import {
  SOURCE_KIND_LABEL,
  SOURCE_KIND_ORDER,
  type KnowledgeSourceKind,
  type SetBanner,
} from "./knowledgeLabels";

const ALLOWED_EXT = [".pdf", ".txt", ".md"];
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

interface UploadReportFormProps {
  onRegistered: () => Promise<void>;
  onBanner: SetBanner;
  onClose: () => void;
}

interface UploadResponse {
  ok?: boolean;
  alreadyRegistered?: boolean;
  source?: KnowledgeSourceDto;
  message?: string;
  error?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** (f) 새 보고서 등록 — multipart 업로드 폼. 등록만 하며 추출은 별도. */
export function UploadReportForm({ onRegistered, onBanner, onClose }: UploadReportFormProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>("");
  const [kind, setKind] = useState<KnowledgeSourceKind>("ops_interview");
  const [title, setTitle] = useState("");
  const [program, setProgram] = useState("");
  const [institution, setInstitution] = useState("");
  const [sourceDate, setSourceDate] = useState<string>(todayIso());
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string>("");

  async function handleSubmit() {
    if (submitting) return; // 이중 제출 방지
    const file = fileRef.current?.files?.[0] ?? null;
    if (!file) {
      setLocalError("업로드할 파일을 선택하세요.");
      return;
    }
    const lower = file.name.toLowerCase();
    if (!ALLOWED_EXT.some((ext) => lower.endsWith(ext))) {
      setLocalError(".pdf / .txt / .md 파일만 등록할 수 있습니다.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setLocalError("파일 크기는 20MB 이하여야 합니다.");
      return;
    }
    setLocalError("");
    setSubmitting(true);

    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    if (title.trim()) form.append("title", title.trim());
    if (program.trim()) form.append("program", program.trim());
    if (institution.trim()) form.append("institution", institution.trim());
    form.append("sourceDate", sourceDate);

    try {
      const res = await fetch("/internal/knowledge/api/sources", { method: "POST", body: form });
      let payload: UploadResponse = {};
      try {
        payload = (await res.json()) as UploadResponse;
      } catch {
        // 본문 없음
      }

      if (res.ok && payload.ok) {
        if (payload.alreadyRegistered) {
          onBanner({ kind: "warn", text: "이미 등록된 파일입니다 (멱등 — 새로 적재하지 않았습니다)." });
        } else {
          onBanner({ kind: "ok", text: "등록됨 — 아래 목록에서 [추출 실행]으로 이어가세요." });
        }
        // 폼 초기화(파일 input 은 ref 로 리셋).
        if (fileRef.current) fileRef.current.value = "";
        setFileName("");
        setTitle("");
        setProgram("");
        setInstitution("");
        await onRegistered();
        onClose();
      } else {
        const msg = payload.message ?? payload.error ?? "등록에 실패했습니다.";
        setLocalError(msg);
        onBanner({ kind: "error", text: `등록 실패: ${msg}` });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "네트워크 오류가 발생했습니다.";
      setLocalError(msg);
      onBanner({ kind: "error", text: `등록 실패: ${msg}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">새 보고서 등록</p>
        <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={submitting} aria-label="닫기">
          <X />
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* 파일 */}
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="knowledge-upload-file">보고 문서 (.pdf / .txt / .md · 20MB 이하)</Label>
          <Input
            id="knowledge-upload-file"
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md"
            className="h-11 cursor-pointer py-2.5"
            onChange={(event) => {
              setFileName(event.target.files?.[0]?.name ?? "");
              setLocalError("");
            }}
          />
          {fileName ? <p className="truncate text-xs text-muted-foreground">선택됨: {fileName}</p> : null}
        </div>

        {/* kind */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="knowledge-upload-kind">문서 종류</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as KnowledgeSourceKind)}>
            <SelectTrigger id="knowledge-upload-kind" size="sm" className="w-full">
              <SelectValue>
                {(value) => (value ? SOURCE_KIND_LABEL[value as KnowledgeSourceKind] : "선택")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SOURCE_KIND_ORDER.map((k) => (
                <SelectItem key={k} value={k}>
                  {SOURCE_KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* sourceDate */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="knowledge-upload-date">문서 일자</Label>
          <Input
            id="knowledge-upload-date"
            type="date"
            className="h-10"
            value={sourceDate}
            onChange={(event) => setSourceDate(event.target.value)}
          />
        </div>

        {/* title */}
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="knowledge-upload-title">제목 (선택 · 미입력 시 파일명)</Label>
          <Input
            id="knowledge-upload-title"
            className="h-10"
            placeholder="예: 2026 상반기 담당자 인터뷰 정리"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        {/* program */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="knowledge-upload-program">프로그램 힌트 (선택)</Label>
          <Input
            id="knowledge-upload-program"
            className="h-10"
            placeholder="예: 청년창업사관학교"
            value={program}
            onChange={(event) => setProgram(event.target.value)}
          />
        </div>

        {/* institution */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="knowledge-upload-institution">기관 힌트 (선택)</Label>
          <Input
            id="knowledge-upload-institution"
            className="h-10"
            placeholder="예: 중소벤처기업진흥공단"
            value={institution}
            onChange={(event) => setInstitution(event.target.value)}
          />
        </div>
      </div>

      {localError ? <p className="text-xs text-destructive">{localError}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={submitting}>
          {submitting ? <Spinner className="size-3.5" /> : <UploadCloud data-icon="inline-start" />}
          {submitting ? "등록 중…" : "등록"}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose} disabled={submitting}>
          취소
        </Button>
        <span className="text-xs text-muted-foreground">등록 후 목록에서 추출을 실행하세요.</span>
      </div>
    </div>
  );
}

"use client";

/**
 * workspace 하단 바 (Apply Experience v2 · §4.3 · P2-8).
 *
 * 문서 선택 드롭다운(여러 documentKey 일 때 — ?document= 갱신으로 재로드) · 진행률(§4.3 정의)
 * · HWPX 다운로드(hwpxTemplateAvailable=false 면 버튼 대신 사유 고지).
 *
 * 다운로드는 body `{format:"hwpx"}` 만 보낸다(P2a 가 answers 동봉을 폐기 — 서버 저장 파생 filledFields 사용).
 * 미채움 잔여(label 충돌 제외분 포함)는 X-Cunote-Hwpx-Unfilled 헤더로 받아 그대로 표시만 한다.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkspaceDocumentOption } from "@/lib/server/documents/workspaceData";

export interface WorkspaceProgress {
  total: number;
  confirmed: number;
  requiredTotal: number;
  requiredConfirmed: number;
}

export function WorkspaceFooter({
  grantId,
  documents,
  activeDocumentKey,
  draftId,
  hwpxTemplateAvailable,
  progress,
  answersSaving,
}: {
  grantId: string;
  documents: WorkspaceDocumentOption[];
  activeDocumentKey: string | null;
  draftId: string | null;
  hwpxTemplateAvailable: boolean;
  progress: WorkspaceProgress | null;
  answersSaving: boolean;
}) {
  const router = useRouter();

  return (
    <div className="border-t bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {documents.length > 1 && activeDocumentKey ? (
            <Select
              value={activeDocumentKey}
              onValueChange={(next) => {
                if (next && next !== activeDocumentKey) {
                  router.push(`/grants/${encodeURIComponent(grantId)}/workspace?document=${encodeURIComponent(next)}`);
                }
              }}
            >
              <SelectTrigger aria-label="작성할 서류 선택" className="min-w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {documents.map((document) => (
                    <SelectItem key={document.documentKey} value={document.documentKey}>
                      {document.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : documents.length === 1 ? (
            <span className="text-sm font-medium">{documents[0]!.label}</span>
          ) : null}
          {progress ? <ProgressMeter progress={progress} /> : null}
        </div>
        <div className="flex items-center gap-2">
          {hwpxTemplateAvailable ? (
            <WorkspaceDownloadButton draftId={draftId} saving={answersSaving} />
          ) : (
            <span className="text-xs text-muted-foreground">
              이 서류는 원본 양식 채움을 지원하지 않습니다.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProgressMeter({ progress }: { progress: WorkspaceProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.confirmed / progress.total) * 100) : 0;
  const label =
    progress.requiredTotal >= 1
      ? `필수 ${progress.requiredConfirmed}/${progress.requiredTotal} · 전체 ${progress.confirmed}/${progress.total}`
      : `${progress.confirmed}/${progress.total}`;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
        {/* 동적 계산값(진행률 %) — Tailwind 유틸로 표현 불가, 인라인 style 예외 유지 */}
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{label}</span>
    </div>
  );
}

export function WorkspaceDownloadButton({
  draftId,
  label = "HWPX 다운로드",
  className,
  saving = false,
}: {
  draftId: string | null;
  label?: string;
  className?: string;
  saving?: boolean;
}) {
  const [pending, setPending] = useState(false);

  async function downloadHwpx() {
    if (!draftId || saving) return;
    setPending(true);
    try {
      const response = await fetch(`/api/web/document-drafts/${encodeURIComponent(draftId)}/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "hwpx" }),
      });
      if (!response.ok) {
        throw new Error(await hwpxErrorMessage(response));
      }
      const blob = await response.blob();
      const filename = hwpxDownloadFilename(response) ?? "지원서-양식.hwpx";
      triggerBlobDownload(blob, filename);
      const unfilled = parseUnfilledHeader(response.headers.get("X-Cunote-Hwpx-Unfilled"));
      if (unfilled.length > 0) {
        const labels = unfilled.map((entry) => entry.label).filter(Boolean).join(", ");
        toast.warning(
          `${unfilled.length.toLocaleString("ko-KR")}개 항목은 자동으로 채우지 못했습니다: ${labels} — 다운로드한 파일에서 직접 입력하세요.`,
        );
      } else {
        toast.success("원본 HWPX 양식에 확정한 값을 채워 다운로드했습니다.");
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "원본 HWPX 양식에 값을 채워 다운로드하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      onClick={() => void downloadHwpx()}
      disabled={pending || saving || !draftId}
      className={className}
    >
      {pending || saving ? (
        <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
      ) : (
        <Download data-icon="inline-start" aria-hidden />
      )}
      {saving ? "값 저장 중…" : label}
    </Button>
  );
}

// ── HWPX 다운로드 클라이언트 헬퍼(구 초안 편집기 헬퍼와 동형 · answers 동봉 없이 format 만) ──

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function parseUnfilledHeader(headerValue: string | null): Array<{ label: string; reason: string }> {
  if (!headerValue) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(headerValue)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { label: string; reason?: string } =>
        typeof entry === "object" && entry !== null && typeof (entry as { label?: unknown }).label === "string",
      )
      .map((entry) => ({ label: entry.label, reason: typeof entry.reason === "string" ? entry.reason : "" }));
  } catch {
    return [];
  }
}

async function hwpxErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ActionResult<null>;
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // 비 JSON 응답: 기본 메시지로 폴백.
  }
  return "원본 HWPX 양식에 값을 채워 다운로드하지 못했습니다.";
}

function hwpxDownloadFilename(response: Response): string | null {
  const disposition = response.headers.get("content-disposition");
  if (!disposition) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // fall through to plain filename
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain?.[1] ?? null;
}

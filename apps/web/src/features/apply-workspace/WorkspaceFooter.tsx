"use client";

/**
 * HWPX 다운로드 버튼 + 다운로드 클라이언트 헬퍼 (Apply Experience v2 · §4.3 · P2-8).
 *
 * 2026-07-15 워크스페이스 재정의(docs/research/2026-07-15-작성도우미-워크스페이스-재정의.md §2-⑤)로
 * 상시 하단 바(WorkspaceFooter)와 이중 진행 표시(ProgressMeter)는 해체됐다. 문서 Select 는 상단 바로,
 * 진행 표시는 단일 축(confirmed/total)으로 WorkspaceView 상단 바에 편입됐다. 이 파일에는
 * 다운로드 버튼과 그 HWPX 헬퍼만 남는다(완료 카드 주 CTA + 전체 목록 하단 보조 버튼이 재사용).
 *
 * 다운로드는 body `{format:"hwpx"}` 만 보낸다(P2a 가 answers 동봉을 폐기 — 서버 저장 파생 filledFields 사용).
 * 미채움 잔여(label 충돌 제외분 포함)는 X-Cunote-Hwpx-Unfilled 헤더로 받아 그대로 표시만 한다.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";

export function WorkspaceDownloadButton({
  draftId,
  label = "HWPX 다운로드",
  className,
  variant = "default",
  saving = false,
}: {
  draftId: string | null;
  label?: string;
  className?: string;
  variant?: "default" | "outline";
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
      variant={variant}
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

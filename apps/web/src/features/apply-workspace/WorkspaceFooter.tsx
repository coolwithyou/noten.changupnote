"use client";

/**
 * HWP/HWPX 원본 다운로드 버튼 + rhwp 검증 클라이언트 헬퍼 (Apply Experience v2 · §4.3 · P2-8).
 *
 * 2026-07-15 워크스페이스 재정의(docs/research/2026-07-15-작성도우미-워크스페이스-재정의.md §2-⑤)로
 * 상시 하단 바(WorkspaceFooter)와 이중 진행 표시(ProgressMeter)는 해체됐다. 문서 Select 는 상단 바로,
 * 진행 표시는 단일 축(confirmed/total)으로 WorkspaceView 상단 바에 편입됐다. 이 파일에는
 * 다운로드 버튼과 그 HWPX 헬퍼만 남는다(완료 카드 주 CTA + 전체 목록 하단 보조 버튼이 재사용).
 *
 * 기본 경로는 인증된 원본 bytes에 accepted|edited만 rhwp로 적용하고 실제 산출물을 재로드 검증한다.
 * rhwp 실패 + HWPX 템플릿 가능 문서만 기존 서버 `{format:"hwpx"}` 내보내기로 폴백한다.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { RhwpFieldAnchor } from "@/lib/rhwp/fieldAnchors";
import { applyRhwpEditFields, buildRhwpEditFields } from "@/lib/rhwp/editPlan";
import {
  downloadBytes,
  exportVerifiedRhwpDocument,
  loadRhwp,
  type RhwpDocumentFormat,
} from "@/lib/rhwp/client";

export function WorkspaceDownloadButton({
  draftId,
  label = "HWPX 다운로드",
  className,
  variant = "default",
  saving = false,
  answers,
  connectedFields,
  manualAnchors,
  duplicateLabels,
  hwpxFallbackAvailable = false,
}: {
  draftId: string | null;
  label?: string;
  className?: string;
  variant?: "default" | "outline";
  saving?: boolean;
  answers: DraftFieldAnswers;
  connectedFields: readonly ConnectedDocumentField[];
  manualAnchors: readonly RhwpFieldAnchor[];
  duplicateLabels?: ReadonlySet<string>;
  hwpxFallbackAvailable?: boolean;
}) {
  const [pending, setPending] = useState(false);

  async function downloadDocument() {
    if (!draftId || saving) return;
    setPending(true);
    try {
      const result = await downloadWithRhwp({
        draftId,
        answers,
        connectedFields,
        manualAnchors,
        ...(duplicateLabels ? { duplicateLabels } : {}),
      });
      if (result.skipped.length > 0) {
        const labels = result.skipped.map((entry) => entry.label).filter(Boolean).join(", ");
        toast.warning(
          `${result.skipped.length.toLocaleString("ko-KR")}개 항목은 안전한 위치를 확정하지 못했습니다: ${labels} — 다운로드한 파일에서 직접 입력하세요.`,
        );
      } else {
        toast.success(`원본 ${result.format.toUpperCase()} 양식에 확정한 값을 채우고 다시 열어 검증했습니다.`);
      }
    } catch (caught) {
      if (hwpxFallbackAvailable) {
        try {
          await downloadHwpxFallback(draftId);
          toast.warning("rhwp 검증을 통과하지 못해 기존 HWPX 안전 내보내기로 다운로드했습니다.");
          return;
        } catch (fallbackError) {
          toast.error(fallbackError instanceof Error ? fallbackError.message : "원본 양식에 값을 채우지 못했습니다.");
          return;
        }
      }
      toast.error(caught instanceof Error ? caught.message : "원본 양식에 값을 채워 다운로드하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      onClick={() => void downloadDocument()}
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

async function downloadWithRhwp(input: {
  draftId: string;
  answers: DraftFieldAnswers;
  connectedFields: readonly ConnectedDocumentField[];
  manualAnchors: readonly RhwpFieldAnchor[];
  duplicateLabels?: ReadonlySet<string>;
}): Promise<{ format: RhwpDocumentFormat; skipped: Array<{ label: string; reason: string }> }> {
  const response = await fetch(
    `/api/web/document-drafts/${encodeURIComponent(input.draftId)}/source-file`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(await sourceFileErrorMessage(response));
  const formatHeader = response.headers.get("x-cunote-document-format");
  if (formatHeader !== "hwp" && formatHeader !== "hwpx") {
    throw new Error("원본 문서 형식을 확인하지 못했습니다.");
  }
  const encodedFilename = response.headers.get("x-cunote-document-filename");
  const originalFilename = encodedFilename ? decodeHeaderValue(encodedFilename) : `지원서-양식.${formatHeader}`;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const rhwp = await loadRhwp();
  const document = new rhwp.HwpDocument(bytes);
  try {
    const plan = buildRhwpEditFields({
      answers: input.answers,
      connectedFields: input.connectedFields,
      ...(input.duplicateLabels ? { duplicateLabels: input.duplicateLabels } : {}),
    });
    const applied = applyRhwpEditFields(document, plan.fields, input.manualAnchors);
    const verification = exportVerifiedRhwpDocument({ rhwp, document, format: formatHeader });
    const extensionPattern = /\.(hwp|hwpx)$/i;
    const base = originalFilename.replace(extensionPattern, "");
    downloadBytes(verification.bytes, `${base}-창업노트-작성본.${formatHeader}`);
    return {
      format: formatHeader,
      skipped: [...plan.skipped, ...applied.skipped].map(({ label, reason }) => ({ label, reason })),
    };
  } finally {
    document.free();
  }
}

async function downloadHwpxFallback(draftId: string): Promise<void> {
  const response = await fetch(`/api/web/document-drafts/${encodeURIComponent(draftId)}/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "hwpx" }),
  });
  if (!response.ok) throw new Error(await hwpxErrorMessage(response));
  const blob = await response.blob();
  const filename = hwpxDownloadFilename(response) ?? "지원서-양식.hwpx";
  triggerBlobDownload(blob, filename);
  const unfilled = parseUnfilledHeader(response.headers.get("X-Cunote-Hwpx-Unfilled"));
  if (unfilled.length > 0) {
    const labels = unfilled.map((entry) => entry.label).filter(Boolean).join(", ");
    toast.warning(
      `${unfilled.length.toLocaleString("ko-KR")}개 항목은 자동으로 채우지 못했습니다: ${labels} — 다운로드한 파일에서 직접 입력하세요.`,
    );
  }
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function sourceFileErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ActionResult<null>;
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // 비 JSON 응답은 기본 문구.
  }
  return "원본 HWP/HWPX 양식을 불러오지 못했습니다.";
}

// ── 기존 HWPX 서버 폴백 헬퍼(answers 동봉 없이 서버 저장 확정값만 사용) ──

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

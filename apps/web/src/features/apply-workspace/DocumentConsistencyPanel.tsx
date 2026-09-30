"use client";

import { useEffect, useRef, useState } from "react";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { companyScopedFetch } from "@/lib/navigation/companyContext";
import type { WritingContext } from "@/lib/documents/writingContext";
import type { DocumentConsistencyReport } from "@/lib/rhwp/documentConsistency";
import type { RhwpStudioSurfaceHandle } from "./RhwpStudioSurface";

export function DocumentConsistencyPanel({ draftId, getSurface, disabled }: {
  draftId: string; getSurface: () => RhwpStudioSurfaceHandle | null; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DocumentConsistencyReport | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function inspect() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const surface = getSurface();
    setBusy(true); setError(""); setResult(null);
    try {
      if (!surface) throw new Error("문서가 열린 뒤 다시 점검해 주세요.");
      const response = await companyScopedFetch(`/api/web/document-drafts/${encodeURIComponent(draftId)}/writing-brief`, { signal: controller.signal, cache: "no-store" });
      const payload = await response.json() as ActionResult<WritingContext>;
      if (!response.ok || !payload.ok || !payload.data) throw new Error(payload.error?.message ?? "사업 설명을 불러오지 못했습니다.");
      if (controller.signal.aborted) return;
      const checked = await surface.inspectDocumentConsistency(payload.data.brief);
      if (!controller.signal.aborted) setResult(checked);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "문서를 점검하지 못했습니다.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setOpen(true); void inspect(); }}>현재 문서 점검</Button>
    <Sheet open={open} onOpenChange={(next) => { setOpen(next); if (!next) { request.current?.abort(); setResult(null); setBusy(false); } }}>
      <SheetContent className="overflow-y-auto p-6 sm:max-w-xl">
        <SheetTitle>현재 문서의 사업명·수치 점검</SheetTitle>
        <SheetDescription className="mt-3">현재 편집 중인 양식과 저장된 사업 설명을 대조합니다. 점검은 문서를 저장하거나 수정하지 않아요.</SheetDescription>
        <p className="mt-3 text-sm text-muted-foreground">‘항목: 값’으로 적힌 내용과 단순한 두 칸 표를 읽습니다. 원문 예시·작성 안내에 적힌 값일 수도 있으니 표시한 위치를 확인해 주세요. 그림·복잡한 표·자유 문장과 제출 조건은 별도 검토가 필요해요.</p>
        {busy ? <p className="mt-4 text-sm" role="status">현재 문서를 읽고 있어요…</p> : null}
        {error ? <p className="mt-4 text-sm text-destructive" role="alert">{error}</p> : null}
        {result ? <div className="mt-5 space-y-4">
          <p className="text-sm">점검 시점의 {result.pageCount}쪽 문서에서 본문·셀·항목 묶음 {result.report.checkedSections}개를 읽고, 저장된 사업 설명과 함께 수치 항목 {result.report.recognizedValues}개를 대조했어요. 이후 편집한 내용은 다시 점검해 주세요.</p>
          {result.skippedTables > 0 ? <p className="text-sm text-muted-foreground">구조를 읽지 못한 표 {result.skippedTables}개는 점검에 포함하지 못했어요.</p> : null}
          {result.report.issues.map((issue, index) => <div key={index} className="rounded-lg border p-4">
            <p className="text-sm font-semibold">{issue.message}</p>
            <ul className="mt-2 space-y-2 text-sm">{issue.entries.map((entry, entryIndex) => <li key={entryIndex}>{entry.label}: {entry.value}</li>)}</ul>
          </div>)}
          {result.report.issues.length === 0 ? <p className="text-sm">읽은 항목에서 대조 가능한 불일치를 찾지 못했어요. 전체 문서의 정확성이나 제출 가능성을 확인한 결과는 아닙니다.</p> : null}
        </div> : null}
        <Button type="button" variant="outline" className="mt-5" disabled={busy || disabled} onClick={() => void inspect()}>현재 내용으로 다시 점검</Button>
      </SheetContent>
    </Sheet>
  </>;
}

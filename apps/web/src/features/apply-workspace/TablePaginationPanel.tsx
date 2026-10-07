"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { TablePaginationTarget } from "@/lib/rhwp/tablePagination";
import type { RhwpStudioSurfaceHandle } from "./RhwpStudioSurface";

export function TablePaginationPanel({ getSurface, onBusyChange }: {
  getSurface: () => RhwpStudioSurfaceHandle | null; onBusyChange: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<TablePaginationTarget[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false); }; }, [onBusyChange]);

  async function run(action: (surface: RhwpStudioSurfaceHandle) => Promise<void>) {
    if (pending.current) return;
    const surface = getSurface();
    if (!surface) { setError("문서가 열린 뒤 다시 시도해 주세요."); return; }
    pending.current = true; setBusy(true); onBusyChange(true); setError(""); setMessage("");
    try { await action(surface); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "표 배치를 변경하지 못했습니다."); }
    finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); onBusyChange(false); setCanUndo(surface.canUndoTablePagination()); }
    }
  }
  function inspect() { void run(async (surface) => {
    const next = await surface.inspectTablePagination();
    if (mounted.current) setTargets(next);
  }); }
  return <>
    <Button type="button" size="sm" variant="outline" onClick={() => { setOpen(true); setTargets(null); inspect(); }}>표 쪽 나눔</Button>
    <Sheet open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <SheetContent className="overflow-y-auto p-6 sm:max-w-xl">
        <SheetTitle>긴 표를 여러 쪽에 나누기</SheetTitle>
        <SheetDescription className="mt-3">문안이 길어 표가 용지 밖으로 밀릴 때 사용할 수 있어요. 선택한 표의 ‘글자처럼 취급’을 해제합니다. 문구는 유지하지만 표 위치와 쪽 수가 달라질 수 있으니 적용 후 문서를 확인해 주세요.</SheetDescription>
        <p className="mt-3 text-sm text-muted-foreground">변경하면 현재 문서와 함께 새 저장본을 만듭니다. 다른 편집을 하기 전까지 이 변경을 되돌릴 수 있어요.</p>
        <div className="mt-5 space-y-4">
          {targets?.map((target) => <div className="rounded-lg border p-4" key={`${target.section}:${target.parentPara}:${target.controlIndex}`}>
            <p className="text-xs text-muted-foreground">현재 {target.page}쪽의 표</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{target.label}</p>
            <Button type="button" className="mt-3" disabled={busy} onClick={() => void run(async (surface) => {
              await surface.applyTablePagination(target);
              if (mounted.current) { setTargets(null); setMessage("표 배치를 변경하고 저장했어요. 문서의 쪽 나눔과 표 위치를 확인해 주세요."); }
            })}>이 표의 쪽 나눔 허용</Button>
          </div>)}
          {targets?.length === 0 ? <p className="text-sm">이 방법으로 변경할 표가 없습니다. 이미 쪽 나눔이 허용되어 있거나 양식에서 나누지 않도록 정한 표일 수 있어요.</p> : null}
          {busy ? <p role="status" className="text-sm">문서를 확인하고 있어요…</p> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {message ? <p role="status" className="text-sm">{message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={inspect}>표 다시 확인</Button>
            {canUndo ? <Button type="button" variant="outline" disabled={busy} onClick={() => void run(async (surface) => {
              await surface.undoTablePagination();
              if (mounted.current) { setTargets(null); setMessage("표 배치 변경 전 저장본으로 되돌렸어요."); }
            })}>쪽 나눔 변경 되돌리기</Button> : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </>;
}

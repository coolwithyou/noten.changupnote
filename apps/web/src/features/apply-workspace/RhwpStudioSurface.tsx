"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, FilePenLine, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { RhwpFieldAnchor } from "@/lib/rhwp/fieldAnchors";
import { exportVerifiedEditorDocument, RHWP_STUDIO_URL } from "@/lib/rhwp/editorClient";
import { prepareRhwpWorkingDocument, type RhwpWorkingDocument } from "@/lib/rhwp/workingDocument";
import type { DocumentAuthoringTask } from "./documentAuthoring";

type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor;

export interface RhwpStudioSurfaceHandle {
  saveAndReturn(): Promise<void>;
}

type StudioState =
  | { status: "loading"; message: string; allowEditorInteraction?: boolean }
  | { status: "ready"; pageCount: number; skipped: RhwpWorkingDocument["skipped"] }
  | { status: "saving"; pageCount: number }
  | { status: "error"; message: string };

export const RhwpStudioSurface = forwardRef<RhwpStudioSurfaceHandle, {
  draftId: string;
  answers: DraftFieldAnswers;
  quickFields: readonly ConnectedDocumentField[];
  manualAnchors: readonly RhwpFieldAnchor[];
  duplicateLabels: ReadonlySet<string>;
  workingDocument: RhwpWorkingDocument | null;
  activeTask: DocumentAuthoringTask | null;
  onSavedAndReturn: (document: RhwpWorkingDocument, taskFieldId: string | null) => void;
}>(({
  draftId,
  answers,
  quickFields,
  manualAnchors,
  duplicateLabels,
  workingDocument,
  activeTask,
  onSavedAndReturn,
}, ref) => {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StudioState>({ status: "loading", message: "작업 문서를 준비하고 있어요." });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<RhwpEditorInstance | null>(null);
  const preparedRef = useRef<RhwpWorkingDocument | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let disposed = false;
    const initialize = async () => {
      setState({ status: "loading", message: "확정한 빠른 작성 값을 원본 문서에 반영하고 있어요." });
      const prepared = await prepareRhwpWorkingDocument({
        draftId,
        answers,
        connectedFields: quickFields,
        manualAnchors,
        duplicateLabels,
        base: workingDocument,
      });
      if (disposed || requestSeq.current !== seq) return;
      preparedRef.current = prepared;
      setState({ status: "loading", message: "자가 호스팅 rhwp Studio를 불러오고 있어요." });
      const { createEditor } = await import("@rhwp/editor");
      if (!containerRef.current) throw new Error("문서 편집 화면을 준비하지 못했습니다.");
      const editor = await createEditor(containerRef.current, {
        studioUrl: RHWP_STUDIO_URL,
        requestTimeoutMs: 180_000,
      });
      if (disposed || requestSeq.current !== seq) {
        editor.destroy();
        return;
      }
      editorRef.current = editor;
      // loadFile 도중 Studio가 원본 형식 경고/글꼴 확인을 띄울 수 있다. 이 단계에서는 부모
      // 오버레이가 iframe 클릭을 가로막으면 Promise가 끝나지 않으므로 편집기를 노출한다.
      setState({
        status: "loading",
        message: "문서 안에 확인창이 나오면 원본을 보존하려면 ‘그대로 보기’를 선택해 주세요.",
        allowEditorInteraction: true,
      });
      const result = await editor.loadFile(prepared.bytes.slice(), prepared.filename);
      if (disposed || requestSeq.current !== seq) return;
      setState({ status: "ready", pageCount: result.pageCount, skipped: prepared.skipped });
    };
    void initialize().catch((caught) => {
      if (disposed || requestSeq.current !== seq) return;
      setState({ status: "error", message: caught instanceof Error ? caught.message : "문서 편집기를 열지 못했습니다." });
    });
    return () => {
      disposed = true;
      requestSeq.current += 1;
      editorRef.current?.destroy();
      editorRef.current = null;
      preparedRef.current = null;
    };
  }, [answers, attempt, draftId, duplicateLabels, manualAnchors, quickFields, workingDocument]);

  const saveAndReturn = useCallback(async () => {
    const editor = editorRef.current;
    const prepared = preparedRef.current;
    if (!editor || !prepared || state.status === "loading" || state.status === "error") return;
    const pageCount = await editor.pageCount();
    setState({ status: "saving", pageCount });
    try {
      const bytes = await exportVerifiedEditorDocument(editor, prepared.format);
      const saved: RhwpWorkingDocument = { ...prepared, bytes };
      toast.success("Studio 편집본을 검증해 이 브라우저 탭에 저장했습니다.");
      onSavedAndReturn(saved, activeTask?.fieldId ?? null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Studio 편집본을 저장하지 못했습니다.";
      setState({ status: "error", message });
      toast.error(message);
    }
  }, [activeTask?.fieldId, onSavedAndReturn, state.status]);

  useImperativeHandle(ref, () => ({ saveAndReturn }), [saveAndReturn]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-xl)] border border-studio/30 bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-studio/35 bg-studio-soft text-studio">
              <FilePenLine data-icon="inline-start" aria-hidden />
              문서 직접 편집
            </Badge>
            {activeTask ? <strong className="truncate text-sm">현재 과제: {activeTask.label}</strong> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            전체 문서를 직접 편집할 수 있어요. 저장본은 현재 브라우저 탭에서 최종 다운로드에 사용됩니다.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => void saveAndReturn()}
          disabled={state.status !== "ready"}
        >
          {state.status === "saving" ? <Spinner data-icon="inline-start" /> : <ArrowLeft data-icon="inline-start" aria-hidden />}
          {state.status === "saving" ? "검증해 저장 중…" : "저장하고 빠른 작성으로"}
        </Button>
      </div>

      {state.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>문서 편집기를 열거나 저장하지 못했습니다.</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw data-icon="inline-start" aria-hidden />
              다시 시도
            </Button>
          </div>
        </Alert>
      ) : null}

      {state.status === "ready" && state.skipped.length > 0 ? (
        <Alert className="border-warning-strong/30 bg-warning-strong-soft">
          <AlertTitle>빠른 작성 값 {state.skipped.length.toLocaleString("ko-KR")}개는 자동 반영하지 않았어요.</AlertTitle>
          <AlertDescription>
            Studio에서 직접 확인해 주세요: {state.skipped.map((entry) => entry.label).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="relative min-h-[68dvh] flex-1 overflow-hidden rounded-[var(--radius-xl)] border bg-card shadow-[var(--shadow-standard)]">
        {state.status === "loading" && state.allowEditorInteraction ? (
          <div className="pointer-events-none absolute top-3 left-1/2 z-10 w-[min(92%,42rem)] -translate-x-1/2 rounded-[var(--radius-lg)] border border-warning-strong/30 bg-card/95 px-3 py-2 text-center text-xs text-muted-foreground shadow-[var(--shadow-subtle)] backdrop-blur-sm">
            {state.message}
          </div>
        ) : state.status === "loading" || state.status === "saving" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-[var(--shadow-subtle)]">
              <Spinner className="text-primary" />
              {state.status === "loading" ? state.message : "편집본을 다시 열어 검증하고 있어요."}
            </div>
          </div>
        ) : state.status === "ready" ? (
          <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full border bg-card/95 px-2.5 py-1 text-xs text-muted-foreground shadow-[var(--shadow-subtle)]">
            <CheckCircle2 className="size-3.5 text-success" aria-hidden />
            {state.pageCount.toLocaleString("ko-KR")}쪽 열림
          </div>
        ) : null}
        <div ref={containerRef} className="h-full min-h-[68dvh] w-full" aria-label="rhwp 문서 직접 편집기" />
      </div>
    </div>
  );
});

RhwpStudioSurface.displayName = "RhwpStudioSurface";

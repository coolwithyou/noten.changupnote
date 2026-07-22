"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon, FileTextIcon, PencilIcon, Wand2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { DEMO_FIELDS, prefillHwpFields, type AutofillResult } from "./autofill";

export interface LabNotice {
  grantId: string;
  title: string;
  source: string;
  agencyPrimary: string | null;
  applyEnd: string | null;
  attachments: Array<{ id: string; filename: string; bytes: number | null }>;
}

interface PreviewMetrics {
  fetchMs: number;
  parseMs: number;
  renderMs: number;
  bytes: number;
  pageCount: number;
  rhwpVersion: string;
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; step: string }
  | { status: "error"; message: string }
  | { status: "ready"; pages: string[]; metrics: PreviewMetrics };

type EditorState =
  | { status: "idle" }
  | { status: "loading"; step: string }
  | { status: "error"; message: string }
  | { status: "ready"; attachmentId: string; filename: string; pageCount: number };

type AutofillState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; filled: AutofillResult["filled"]; skipped: AutofillResult["skipped"] }
  | { status: "error"; message: string };

type LabMode = "viewer" | "editor";

type RhwpModule = typeof import("@rhwp/core");
type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor;

/** 자가 호스팅 rhwp-studio (noten 팀 Vercel 정적 프로젝트, v0.7.19 태그 빌드) */
const STUDIO_URL =
  process.env.NEXT_PUBLIC_RHWP_STUDIO_URL ?? "https://changupnote-rhwp-studio.vercel.app/";

let rhwpModulePromise: Promise<RhwpModule> | null = null;

function loadRhwp(): Promise<RhwpModule> {
  if (!rhwpModulePromise) {
    rhwpModulePromise = (async () => {
      const mod = await import("@rhwp/core");
      await mod.default({ module_or_path: "/rhwp_bg.wasm" });
      mod.init_panic_hook();
      return mod;
    })();
    rhwpModulePromise.catch(() => {
      rhwpModulePromise = null;
    });
  }
  return rhwpModulePromise;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function HwpPreviewLab({
  notices,
  loadError,
}: {
  notices: LabNotice[];
  loadError: string | null;
}) {
  const [mode, setMode] = useState<LabMode>("viewer");
  const [selected, setSelected] = useState<{ id: string; filename: string } | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [editorState, setEditorState] = useState<EditorState>({ status: "idle" });
  const [autofill, setAutofill] = useState<AutofillState>({ status: "idle" });
  const [exporting, setExporting] = useState<"hwp" | "hwpx" | null>(null);
  const requestSeq = useRef(0);
  const bufferCache = useRef<{ id: string; filename: string; buffer: ArrayBuffer } | null>(null);
  const editorRef = useRef<RhwpEditorInstance | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  const fetchAttachment = useCallback(
    async (attachmentId: string, filename: string): Promise<ArrayBuffer> => {
      if (bufferCache.current?.id === attachmentId) return bufferCache.current.buffer;
      const res = await fetch(`/api/dev/hwp-preview/file?id=${attachmentId}`);
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(`파일 로드 실패 (${res.status}) ${detail?.error ?? ""}`);
      }
      const buffer = await res.arrayBuffer();
      bufferCache.current = { id: attachmentId, filename, buffer };
      return buffer;
    },
    [],
  );

  const renderInViewer = useCallback(
    async (attachmentId: string, filename: string, seq: number) => {
      setPreview({ status: "loading", step: "파일 다운로드 중" });
      const t0 = performance.now();
      const buffer = await fetchAttachment(attachmentId, filename);
      const fetchMs = performance.now() - t0;
      if (requestSeq.current !== seq) return;

      setPreview({ status: "loading", step: "rhwp WASM 초기화 중" });
      const rhwp = await loadRhwp();
      if (requestSeq.current !== seq) return;

      setPreview({ status: "loading", step: "HWP 파싱·렌더링 중" });
      const t1 = performance.now();
      const doc = new rhwp.HwpDocument(new Uint8Array(buffer));
      const parseMs = performance.now() - t1;
      try {
        const pageCount = doc.pageCount();
        const t2 = performance.now();
        const pages: string[] = [];
        for (let i = 0; i < pageCount; i += 1) {
          pages.push(doc.renderPageSvg(i));
        }
        const renderMs = performance.now() - t2;
        if (requestSeq.current !== seq) return;
        setPreview({
          status: "ready",
          pages,
          metrics: {
            fetchMs: Math.round(fetchMs),
            parseMs: Math.round(parseMs),
            renderMs: Math.round(renderMs),
            bytes: buffer.byteLength,
            pageCount,
            rhwpVersion: rhwp.version(),
          },
        });
      } finally {
        doc.free();
      }
    },
    [fetchAttachment],
  );

  const ensureEditor = useCallback(async (seq: number): Promise<RhwpEditorInstance | null> => {
    if (editorRef.current) return editorRef.current;
    setEditorState({
      status: "loading",
      step: "rhwp-studio 에디터 로딩 중 (자가 호스팅, 최초 1회)",
    });
    const { createEditor } = await import("@rhwp/editor");
    if (!editorContainerRef.current) throw new Error("에디터 컨테이너가 없습니다");
    const editor = await createEditor(editorContainerRef.current, {
      requestTimeoutMs: 180_000,
      studioUrl: STUDIO_URL,
    });
    if (requestSeq.current !== seq) {
      editor.destroy();
      return null;
    }
    editorRef.current = editor;
    return editor;
  }, []);

  const loadInEditor = useCallback(
    async (attachmentId: string, filename: string, seq: number) => {
      if (
        editorState.status === "ready" &&
        editorState.attachmentId === attachmentId
      ) {
        return;
      }
      setEditorState({ status: "loading", step: "파일 다운로드 중" });
      const buffer = await fetchAttachment(attachmentId, filename);
      if (requestSeq.current !== seq) return;

      const editor = await ensureEditor(seq);
      if (!editor) return;

      setEditorState({
        status: "loading",
        step: "문서 로딩 중 — 스튜디오 안에 글꼴 감지/문서 복구 모달이 뜨면 닫아야 완료됩니다",
      });
      const result = await editor.loadFile(buffer, filename);
      if (requestSeq.current !== seq) return;
      setEditorState({
        status: "ready",
        attachmentId,
        filename,
        pageCount: result.pageCount,
      });
    },
    [editorState, fetchAttachment, ensureEditor],
  );

  const openAttachment = useCallback(
    async (attachmentId: string, filename: string, targetMode: LabMode = mode) => {
      const seq = ++requestSeq.current;
      setSelected({ id: attachmentId, filename });
      setAutofill({ status: "idle" });
      try {
        if (targetMode === "viewer") {
          await renderInViewer(attachmentId, filename, seq);
        } else {
          await loadInEditor(attachmentId, filename, seq);
        }
      } catch (error) {
        if (requestSeq.current !== seq) return;
        const message = error instanceof Error ? error.message : String(error);
        if (targetMode === "viewer") setPreview({ status: "error", message });
        else setEditorState({ status: "error", message });
      }
    },
    [mode, renderInViewer, loadInEditor],
  );

  const switchMode = useCallback(
    (next: LabMode) => {
      if (!next || next === mode) return;
      setMode(next);
      if (selected) void openAttachment(selected.id, selected.filename, next);
    },
    [mode, selected, openAttachment],
  );

  const autofillAndOpen = useCallback(async () => {
    if (!selected) return;
    const seq = ++requestSeq.current;
    setMode("editor");
    setAutofill({ status: "running" });
    try {
      setEditorState({ status: "loading", step: "파일 다운로드 중" });
      const buffer = await fetchAttachment(selected.id, selected.filename);
      const rhwp = await loadRhwp();
      if (requestSeq.current !== seq) return;

      setEditorState({
        status: "loading",
        step: "필드 자동 채움 중 (searchAllText → insertTextInCell → exportHwp)",
      });
      const result = prefillHwpFields(rhwp, buffer, DEMO_FIELDS);

      const editor = await ensureEditor(seq);
      if (!editor || requestSeq.current !== seq) return;

      setEditorState({
        status: "loading",
        step: "채움본 로딩 중 — 스튜디오 안에 글꼴 감지/문서 복구 모달이 뜨면 닫아야 완료됩니다",
      });
      const loadResult = await editor.loadFile(result.bytes, selected.filename);
      if (requestSeq.current !== seq) return;
      setEditorState({
        status: "ready",
        attachmentId: `${selected.id}:autofilled`,
        filename: selected.filename,
        pageCount: loadResult.pageCount,
      });
      setAutofill({ status: "done", filled: result.filled, skipped: result.skipped });
    } catch (error) {
      if (requestSeq.current !== seq) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutofill({ status: "error", message });
      setEditorState({ status: "error", message });
    }
  }, [selected, fetchAttachment, ensureEditor]);

  const exportFromEditor = useCallback(
    async (format: "hwp" | "hwpx") => {
      const editor = editorRef.current;
      if (!editor || editorState.status !== "ready") return;
      setExporting(format);
      try {
        const bytes = format === "hwp" ? await editor.exportHwp() : await editor.exportHwpx();
        const base = editorState.filename.replace(/\.(hwpx?|hml)$/i, "");
        downloadBytes(bytes, `${base}-편집본.${format}`);
      } catch (error) {
        setEditorState({
          status: "error",
          message: `내보내기 실패: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        setExporting(null);
      }
    },
    [editorState],
  );

  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col gap-4 p-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">HWP 미리보기 실험실</h1>
        <p className="text-sm text-muted-foreground">
          rhwp(@rhwp/core WASM + @rhwp/editor)로 접수중 공고의 지원서·사업계획서 HWP를
          브라우저에서 렌더링·편집하는 기술검증 페이지
        </p>
      </div>
      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>공고 목록 로드 실패</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-1 gap-4 overflow-hidden">
        <Card className="w-96 shrink-0">
          <CardHeader>
            <CardTitle>접수중 공고 · HWP 서식 첨부</CardTitle>
            <CardDescription>{notices.length}건 (지원서·사업계획서류 파일명 기준)</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[74dvh]">
              <div className="flex flex-col gap-3 pr-3">
                {notices.length === 0 && !loadError ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FileTextIcon />
                      </EmptyMedia>
                      <EmptyTitle>조건에 맞는 공고 없음</EmptyTitle>
                      <EmptyDescription>
                        status=open이면서 HWP 서식 첨부가 아카이브된 공고가 없습니다.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {notices.map((notice) => (
                  <div key={notice.grantId} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{notice.source}</Badge>
                      {notice.applyEnd ? (
                        <span className="text-xs text-muted-foreground">~{notice.applyEnd}</span>
                      ) : null}
                    </div>
                    <p className="text-sm font-medium leading-snug">{notice.title}</p>
                    {notice.agencyPrimary ? (
                      <p className="text-xs text-muted-foreground">{notice.agencyPrimary}</p>
                    ) : null}
                    <div className="flex flex-col gap-1">
                      {notice.attachments.map((attachment) => (
                        <Button
                          key={attachment.id}
                          variant={selected?.id === attachment.id ? "secondary" : "ghost"}
                          size="sm"
                          className="h-auto justify-start py-1.5 text-left"
                          onClick={() => openAttachment(attachment.id, attachment.filename)}
                        >
                          <FileTextIcon data-icon="inline-start" />
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {attachment.filename}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatBytes(attachment.bytes)}
                          </span>
                        </Button>
                      ))}
                    </div>
                    <Separator />
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
        <Card className="min-w-0 flex-1">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="truncate">{selected?.filename ?? "미리보기 / 편집"}</CardTitle>
              <div className="flex shrink-0 items-center gap-2">
                {selected ? (
                  <Button
                    size="sm"
                    disabled={autofill.status === "running"}
                    onClick={autofillAndOpen}
                  >
                    {autofill.status === "running" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <Wand2Icon data-icon="inline-start" />
                    )}
                    자동 채움 → 에디터
                  </Button>
                ) : null}
                {mode === "editor" && editorState.status === "ready" ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={exporting !== null}
                      onClick={() => exportFromEditor("hwp")}
                    >
                      {exporting === "hwp" ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <DownloadIcon data-icon="inline-start" />
                      )}
                      편집본 .hwp
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={exporting !== null}
                      onClick={() => exportFromEditor("hwpx")}
                    >
                      {exporting === "hwpx" ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <DownloadIcon data-icon="inline-start" />
                      )}
                      편집본 .hwpx
                    </Button>
                  </>
                ) : null}
                <ToggleGroup
                  type="single"
                  value={[mode]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "viewer" || next === "editor") switchMode(next);
                  }}
                >
                  <ToggleGroupItem value="viewer" aria-label="미리보기 모드">
                    <FileTextIcon data-icon="inline-start" />
                    미리보기
                  </ToggleGroupItem>
                  <ToggleGroupItem value="editor" aria-label="에디터 모드">
                    <PencilIcon data-icon="inline-start" />
                    에디터
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
            {mode === "viewer" && preview.status === "ready" ? (
              <CardDescription>
                rhwp v{preview.metrics.rhwpVersion} · {preview.metrics.pageCount}쪽 ·{" "}
                {formatBytes(preview.metrics.bytes)} · 다운로드 {preview.metrics.fetchMs}ms · 파싱{" "}
                {preview.metrics.parseMs}ms · SVG 렌더 {preview.metrics.renderMs}ms
              </CardDescription>
            ) : null}
            {mode === "editor" ? (
              <CardDescription>
                {editorState.status === "ready"
                  ? `rhwp-studio 임베드 · ${editorState.pageCount}쪽 · 편집 후 다운로드 버튼으로 저장`
                  : "자가 호스팅 rhwp-studio iframe 임베드. 문서 안을 클릭해 바로 타이핑할 수 있습니다."}
              </CardDescription>
            ) : null}
            {mode === "viewer" && preview.status === "idle" ? (
              <CardDescription>왼쪽에서 첨부파일을 선택하세요.</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            {mode === "viewer" ? (
              <>
                {preview.status === "loading" ? (
                  <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                    <Spinner /> {preview.step}
                  </div>
                ) : null}
                {preview.status === "error" ? (
                  <Alert variant="destructive">
                    <AlertTitle>렌더링 실패</AlertTitle>
                    <AlertDescription>{preview.message}</AlertDescription>
                  </Alert>
                ) : null}
                {preview.status === "ready" ? (
                  <ScrollArea className="h-[70dvh]">
                    <div className="flex flex-col items-center gap-6 bg-muted/40 p-4">
                      {preview.pages.map((svg, index) => (
                        <div
                          key={index}
                          className={cn(
                            "w-full max-w-3xl overflow-hidden rounded-md border bg-white shadow-sm",
                            "[&_svg]:h-auto [&_svg]:w-full",
                          )}
                          dangerouslySetInnerHTML={{ __html: svg }}
                        />
                      ))}
                    </div>
                  </ScrollArea>
                ) : null}
              </>
            ) : null}
            <div className={cn("flex flex-col gap-2", mode !== "editor" && "hidden")}>
              {autofill.status === "done" ? (
                <Alert>
                  <Wand2Icon />
                  <AlertTitle>
                    자동 채움 완료 — {autofill.filled.length}개 필드
                    {autofill.skipped.length > 0 ? ` (${autofill.skipped.length}개 건너뜀)` : ""}
                  </AlertTitle>
                  <AlertDescription>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {autofill.filled.map((f) => (
                        <Badge key={f.key} variant="secondary">
                          {f.label} ← {f.value}
                        </Badge>
                      ))}
                      {autofill.skipped.map((s) => (
                        <Badge key={s.key} variant="outline">
                          {s.value}: {s.reason}
                        </Badge>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {editorState.status === "loading" ? (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                  <Spinner /> {editorState.step}
                </div>
              ) : null}
              {editorState.status === "error" ? (
                <Alert variant="destructive">
                  <AlertTitle>에디터 오류</AlertTitle>
                  <AlertDescription>{editorState.message}</AlertDescription>
                </Alert>
              ) : null}
              {editorState.status === "idle" ? (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  왼쪽에서 첨부파일을 선택하면 에디터로 열립니다.
                </div>
              ) : null}
              <div
                ref={editorContainerRef}
                className={cn(
                  "h-[70dvh] overflow-hidden rounded-md border",
                  editorState.status !== "ready" && editorState.status !== "loading" && "hidden",
                )}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

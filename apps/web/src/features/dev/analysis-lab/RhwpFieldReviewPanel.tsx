"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HwpDocument } from "@rhwp/core";
import {
  CheckCircle2,
  Download,
  Eye,
  FileWarning,
  Pencil,
  SearchX,
} from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  downloadBytes,
  exportVerifiedHwp,
  loadRhwp,
  RHWP_STUDIO_URL,
} from "@/features/dev/hwp-preview/rhwp-client";
import type {
  RoundtripChoiceGroup,
  RoundtripFieldCandidate,
} from "./application-roundtrip-contract";

type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor;
type ReviewMode = "viewer" | "editor";

interface RhwpSearchHit {
  sec: number;
  para: number;
  charOffset: number;
  length: number;
  cellContext?: {
    parentPara: number;
    ctrlIdx: number;
    cellIdx: number;
    cellPara: number;
  };
}

interface CandidateReview {
  id: string;
  label: string;
  kind: "text" | "choice";
  matched: boolean;
  matchedBy: string | null;
  hitCount: number;
  kordocLocation: string;
  rhwpLocation: string | null;
}

interface ViewerReadyState {
  status: "ready";
  pages: string[];
  reviews: CandidateReview[];
  pageCount: number;
  byteLength: number;
  rhwpVersion: string;
}

type ViewerState =
  | { status: "idle" }
  | { status: "loading"; step: string }
  | { status: "error"; message: string }
  | ViewerReadyState;

type EditorState =
  | { status: "idle" }
  | { status: "loading"; step: string }
  | { status: "error"; message: string }
  | { status: "ready"; pageCount: number };

export function RhwpFieldReviewPanel({
  sourceUrl,
  filename,
  sourceLabel,
  fields,
  choiceGroups,
  diagnosticSource = false,
}: {
  sourceUrl: string;
  filename: string;
  sourceLabel: string;
  fields: RoundtripFieldCandidate[];
  choiceGroups: RoundtripChoiceGroup[];
  diagnosticSource?: boolean;
}) {
  const [mode, setMode] = useState<ReviewMode>("viewer");
  const [viewer, setViewer] = useState<ViewerState>({ status: "idle" });
  const [editor, setEditor] = useState<EditorState>({ status: "idle" });
  const [exporting, setExporting] = useState(false);
  const bufferRef = useRef<ArrayBuffer | null>(null);
  const editorRef = useRef<RhwpEditorInstance | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    return () => {
      requestSeq.current += 1;
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  const fetchSource = useCallback(async () => {
    if (bufferRef.current) return bufferRef.current;
    const response = await fetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new Error(detail?.message ?? detail?.error ?? `파일 로드 실패 (HTTP ${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    bufferRef.current = buffer;
    return buffer;
  }, [sourceUrl]);

  const openViewer = useCallback(async () => {
    const seq = ++requestSeq.current;
    setMode("viewer");
    setViewer({ status: "loading", step: "원본 파일을 불러오는 중" });
    try {
      const buffer = await fetchSource();
      if (requestSeq.current !== seq) return;
      setViewer({ status: "loading", step: "rhwp로 파싱·교차 검색하는 중" });
      const rhwp = await loadRhwp();
      if (requestSeq.current !== seq) return;
      const document = new rhwp.HwpDocument(new Uint8Array(buffer));
      try {
        const pageCount = document.pageCount();
        const pages: string[] = [];
        for (let page = 0; page < pageCount; page += 1) {
          pages.push(document.renderPageSvg(page));
        }
        const reviews = buildCandidateReviews(document, fields, choiceGroups);
        if (requestSeq.current !== seq) return;
        setViewer({
          status: "ready",
          pages,
          reviews,
          pageCount,
          byteLength: buffer.byteLength,
          rhwpVersion: rhwp.version(),
        });
      } finally {
        document.free();
      }
    } catch (caught) {
      if (requestSeq.current !== seq) return;
      setViewer({
        status: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, [choiceGroups, fetchSource, fields]);

  const ensureEditor = useCallback(async () => {
    if (editorRef.current) return editorRef.current;
    const container = editorContainerRef.current;
    if (!container) throw new Error("rhwp 에디터 컨테이너를 찾지 못했습니다.");
    const { createEditor } = await import("@rhwp/editor");
    const instance = await createEditor(container, {
      requestTimeoutMs: 180_000,
      studioUrl: RHWP_STUDIO_URL,
    });
    editorRef.current = instance;
    return instance;
  }, []);

  const openEditor = useCallback(async () => {
    const seq = ++requestSeq.current;
    setMode("editor");
    setEditor({ status: "loading", step: "자가호스팅 rhwp 에디터를 준비하는 중" });
    try {
      const [buffer, instance] = await Promise.all([fetchSource(), ensureEditor()]);
      if (requestSeq.current !== seq) return;
      setEditor({ status: "loading", step: "문서를 에디터에 불러오는 중" });
      const result = await instance.loadFile(buffer.slice(0), filename);
      if (requestSeq.current !== seq) return;
      setEditor({ status: "ready", pageCount: result.pageCount });
    } catch (caught) {
      if (requestSeq.current !== seq) return;
      setEditor({
        status: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, [ensureEditor, fetchSource, filename]);

  const exportHwp = useCallback(async () => {
    const instance = editorRef.current;
    if (!instance || editor.status !== "ready") return;
    setExporting(true);
    try {
      const { bytes } = await exportVerifiedHwp(instance);
      const base = filename.replace(/\.(hwpx?|hml)$/i, "");
      downloadBytes(bytes, `${base}-rhwp-검증본.hwp`);
    } catch (caught) {
      setEditor({
        status: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setExporting(false);
    }
  }, [editor, filename]);

  const reviewSummary = useMemo(() => {
    if (viewer.status !== "ready") return null;
    const matched = viewer.reviews.filter((review) => review.matched).length;
    return { matched, total: viewer.reviews.length };
  }, [viewer]);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>rhwp 문서·필드 교차 검토</CardTitle>
              <Badge variant="outline">{sourceLabel}</Badge>
              {reviewSummary ? (
                <Badge variant={reviewSummary.matched === reviewSummary.total ? "default" : "secondary"}>
                  텍스트 교차 확인 {reviewSummary.matched}/{reviewSummary.total}
                </Badge>
              ) : null}
            </div>
            <CardDescription className="mt-1 break-all">
              {filename} · Kordoc 후보를 rhwp 검색 결과와 대조하고 실제 문서에서 눈으로 확인합니다.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={mode === "viewer" ? "default" : "outline"} size="sm" onClick={() => void openViewer()}>
              {viewer.status === "loading" && mode === "viewer" ? <Spinner data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
              미리보기 검증
            </Button>
            <Button variant={mode === "editor" ? "default" : "outline"} size="sm" onClick={() => void openEditor()}>
              {editor.status === "loading" && mode === "editor" ? <Spinner data-icon="inline-start" /> : <Pencil data-icon="inline-start" />}
              에디터로 열기
            </Button>
            {mode === "editor" && editor.status === "ready" ? (
              <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportHwp()}>
                {exporting ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
                검증 후 HWP 다운로드
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {diagnosticSource ? (
          <Alert>
            <FileWarning />
            <AlertTitle>Kordoc 저장본은 진단 입력입니다</AlertTitle>
            <AlertDescription>
              rhwp에서 보이더라도 한컴 호환성을 단정하지 않습니다. 에디터에서 다시 내보낼 때 자기 재로드와 페이지 수 검증을 통과한 HWP만 다운로드됩니다.
            </AlertDescription>
          </Alert>
        ) : null}

        {mode === "viewer" ? (
          <ViewerContent state={viewer} onStart={() => void openViewer()} />
        ) : null}

        <div
          ref={editorContainerRef}
          className={mode === "editor" ? "h-[48rem] min-h-[36rem] overflow-hidden rounded-lg border" : "hidden h-[48rem]"}
        />
        {mode === "editor" && editor.status === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner /> {editor.step}
          </div>
        ) : null}
        {mode === "editor" && editor.status === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>rhwp 에디터를 열지 못했습니다</AlertTitle>
            <AlertDescription>{editor.message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ViewerContent({ state, onStart }: { state: ViewerState; onStart: () => void }) {
  if (state.status === "idle") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center">
        <Eye className="size-8 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">rhwp 교차 검토를 시작하세요</p>
          <p className="text-xs text-muted-foreground">WASM은 버튼을 누를 때만 로드됩니다.</p>
        </div>
        <Button size="sm" onClick={onStart}>미리보기 검증 시작</Button>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Spinner /> {state.step}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>rhwp 미리보기를 만들지 못했습니다</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid min-h-0 gap-3 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col rounded-lg border">
        <div className="border-b p-3 text-xs text-muted-foreground">
          rhwp {state.rhwpVersion} · {state.pageCount}쪽 · {formatBytes(state.byteLength)}
        </div>
        <ScrollArea className="h-[44rem]">
          <div className="flex flex-col gap-2 p-3">
            {state.reviews.length === 0 ? (
              <p className="text-xs text-muted-foreground">교차 검토할 추천 입력 후보가 없습니다.</p>
            ) : null}
            {state.reviews.map((review) => (
              <div key={review.id} className="rounded-md border p-2.5">
                <div className="flex items-start gap-2">
                  {review.matched ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <SearchX className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="break-words text-xs font-medium">{review.label}</span>
                      <Badge variant="outline">{review.kind === "choice" ? "객관식" : "입력"}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Kordoc {review.kordocLocation}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {review.matched
                        ? `rhwp ${review.matchedBy} · ${review.hitCount}건${review.rhwpLocation ? ` · ${review.rhwpLocation}` : ""}`
                        : "rhwp exact-text 검색 미검출 · 눈으로 확인 필요"}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
      <ScrollArea className="h-[44rem] rounded-lg border bg-muted/40">
        <div className="flex flex-col items-center gap-5 p-4">
          {state.pages.map((svg, page) => (
            <div
              key={page}
              className="w-full max-w-4xl overflow-hidden rounded-md border bg-white shadow-sm [content-visibility:auto] [&_svg]:h-auto [&_svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function buildCandidateReviews(
  document: HwpDocument,
  fields: RoundtripFieldCandidate[],
  choiceGroups: RoundtripChoiceGroup[],
): CandidateReview[] {
  const fieldReviews = fields.map((field): CandidateReview => {
    const queries = uniqueQueries([field.label, field.displayLabel, field.originalValue]);
    const matches = searchQueries(document, queries);
    const expectedOccurrence = Math.max(0, field.location.occurrence);
    const chosen = matches.hits[expectedOccurrence] ?? matches.hits[0] ?? null;
    return {
      id: field.fieldInstanceId,
      label: field.displayLabel,
      kind: "text",
      matched: matches.hits.length > expectedOccurrence,
      matchedBy: matches.matchedBy,
      hitCount: matches.hits.length,
      kordocLocation: field.location.target?.kind === "block_text"
        ? `문단 블록 ${field.location.blockIndex + 1}`
        : `표 ${field.location.blockIndex + 1} · 행 ${field.location.row + 1} · 열 ${field.location.col + 1}`,
      rhwpLocation: chosen ? formatRhwpLocation(chosen) : null,
    };
  });

  const choiceReviews = choiceGroups.map((group): CandidateReview => {
    const groupMatch = searchQueries(document, uniqueQueries([group.label]));
    const optionMatches = group.options.map((option) => ({
      label: option.label,
      result: searchQueries(document, uniqueQueries([option.label])),
    }));
    const matchedOptions = optionMatches.filter((entry) => entry.result.hits.length > 0);
    const firstHit = groupMatch.hits[0] ?? matchedOptions[0]?.result.hits[0] ?? null;
    const allOptionsMatched = group.options.length > 0 && matchedOptions.length === group.options.length;
    return {
      id: group.groupId,
      label: group.label,
      kind: "choice",
      matched: groupMatch.hits.length > 0 && allOptionsMatched,
      matchedBy: groupMatch.hits.length > 0
        ? `그룹명 + 옵션 ${matchedOptions.length}/${group.options.length}`
        : matchedOptions.length > 0
          ? `옵션 ${matchedOptions.length}/${group.options.length}`
          : null,
      hitCount: groupMatch.hits.length + optionMatches.reduce((sum, entry) => sum + entry.result.hits.length, 0),
      kordocLocation: `표 ${group.location.tableIndex + 1} · 행 ${group.location.row + 1}`,
      rhwpLocation: firstHit ? formatRhwpLocation(firstHit) : null,
    };
  });

  return [...choiceReviews, ...fieldReviews];
}

function searchQueries(
  document: HwpDocument,
  queries: string[],
): { matchedBy: string | null; hits: RhwpSearchHit[] } {
  for (const query of queries) {
    try {
      const hits = JSON.parse(document.searchAllText(query, false, true)) as RhwpSearchHit[];
      if (hits.length > 0) return { matchedBy: `“${query}”`, hits };
    } catch {
      // 다른 표기 후보로 계속 검색한다.
    }
  }
  return { matchedBy: null, hits: [] };
}

function uniqueQueries(values: Array<string | null | undefined>): string[] {
  return [...new Set(values
    .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
    .filter((value) => value.length >= 2 && value.length <= 160))];
}

function formatRhwpLocation(hit: RhwpSearchHit): string {
  if (hit.cellContext) {
    return `구역 ${hit.sec + 1} · 표 문단 ${hit.cellContext.parentPara + 1} · 셀 ${hit.cellContext.cellIdx + 1}`;
  }
  return `구역 ${hit.sec + 1} · 문단 ${hit.para + 1}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

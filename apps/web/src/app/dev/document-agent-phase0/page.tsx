"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditor, type RhwpEditor } from "@rhwp/editor";
import { RhwpStudioSurface } from "@/features/apply-workspace/RhwpStudioSurface";
import {
  exportVerifiedEditorDocument,
  loadEditorFileWithoutDialogs,
  notifyEditorSaved,
  RHWP_STUDIO_URL,
} from "@/lib/rhwp/editorClient";
import { loadRhwp, type RhwpDocumentFormat, type RhwpModule } from "@/lib/rhwp/client";
import {
  canonicalJson,
  sha256Hex,
  type DocumentEditCandidate,
} from "@/lib/rhwp/documentAgentContract";
import {
  extractDocumentEditCandidates,
} from "@/lib/rhwp/documentAgentCandidates";
import {
  assertDocumentAgentManifestsEqual,
  buildDocumentAgentSemanticManifest,
  type DocumentAgentSemanticManifest,
} from "@/lib/rhwp/documentAgentManifest";
import {
  createStudioCommandDocumentAgentTransaction,
  type StudioCommandDocumentAgentTransaction,
} from "@/lib/rhwp/studioCommandDocumentAgentTransaction";
import {
  resolveStudioDocumentAgentProtocol,
  type StudioDocumentAgentProtocol,
} from "@/lib/rhwp/studioDocumentAgentProtocol";
import type { RhwpWorkingDocument } from "@/lib/rhwp/workingDocument";

type Status =
  | "idle"
  | "scanning"
  | "initial_studio_load_waiting"
  | "ready"
  | "running"
  | "agent_pass"
  | "regression_loading"
  | "regression_ready"
  | "quick_returned"
  | "failed";

interface SourceState {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  filename: string;
  sourceKey: string;
  sourceSha256: string;
  pageCount: number;
  sourceManifest: DocumentAgentSemanticManifest;
  candidate: DocumentEditCandidate;
  scanMs: number;
  candidateCount: number;
}

interface GateResult {
  format: RhwpDocumentFormat;
  candidateScanMs: number;
  candidateCount: number;
  candidateLocationUseful: boolean;
  applyCommandMs: number;
  applyWithinThreeSeconds: boolean;
  applyExportReopen: boolean;
  pageCountStable: boolean;
  nonTargetSemanticStable: boolean;
  studioReexportSemanticStable: boolean;
  undoExact: boolean;
  applyFocused: boolean;
  undoFocused: boolean;
  selectionEditableAfterUndo: boolean;
  documentChangedEvents: string[];
  commandReloadCount: 0;
  repeatedModalRiskRemoved: true;
}

interface RegressionState {
  saveCount: number;
  semanticInputChanged: boolean;
  downloadIntercepted: boolean;
  returnedToQuick: boolean;
  error: string | null;
}

const EMPTY_REGRESSION: RegressionState = {
  saveCount: 0,
  semanticInputChanged: false,
  downloadIntercepted: false,
  returnedToQuick: false,
  error: null,
};

export default function DocumentAgentPhase0Page() {
  const directContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<RhwpEditor | null>(null);
  const rhwpRef = useRef<RhwpModule | null>(null);
  const protocolRef = useRef<StudioDocumentAgentProtocol | null>(null);
  const transactionRef = useRef<StudioCommandDocumentAgentTransaction | null>(null);
  const sourceRef = useRef<SourceState | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("HWP 또는 HWPX 실문서를 선택하세요.");
  const [source, setSource] = useState<SourceState | null>(null);
  const [gate, setGate] = useState<GateResult | null>(null);
  const [showRegression, setShowRegression] = useState(false);
  const [regression, setRegression] = useState<RegressionState>(EMPTY_REGRESSION);
  const regressionRef = useRef(EMPTY_REGRESSION);

  useEffect(() => () => editorRef.current?.destroy(), []);
  useEffect(() => {
    const originalClick = HTMLAnchorElement.prototype.click;
    window.__phase0DownloadProbe = { count: 0 };
    HTMLAnchorElement.prototype.click = function phase0DownloadClick() {
      if (this.download) window.__phase0DownloadProbe!.count += 1;
      originalClick.call(this);
    };
    return () => {
      HTMLAnchorElement.prototype.click = originalClick;
      delete window.__phase0DownloadProbe;
    };
  }, []);

  const updateRegression = useCallback((next: Partial<RegressionState>) => {
    regressionRef.current = { ...regressionRef.current, ...next };
    setRegression(regressionRef.current);
  }, []);

  const fail = useCallback((error: unknown) => {
    setStatus("failed");
    setMessage(error instanceof Error ? error.message : String(error));
  }, []);

  const loadFile = useCallback(async (file: File) => {
    editorRef.current?.destroy();
    editorRef.current = null;
    sourceRef.current = null;
    rhwpRef.current = null;
    protocolRef.current = null;
    transactionRef.current = null;
    setSource(null);
    setGate(null);
    setShowRegression(false);
    regressionRef.current = EMPTY_REGRESSION;
    setRegression(EMPTY_REGRESSION);
    setStatus("initial_studio_load_waiting");
    setMessage("Studio에 실문서를 한 번 로드하고 public command capability를 확인하고 있습니다.");
    try {
      const format = documentFormat(file.name);
      const uploadedBytes = new Uint8Array(await file.arrayBuffer());
      const rhwp = await loadRhwp();
      rhwpRef.current = rhwp;
      if (!directContainerRef.current) throw new Error("Studio 컨테이너를 찾지 못했습니다.");
      const editor = await createEditor(directContainerRef.current, {
        studioUrl: RHWP_STUDIO_URL,
        requestTimeoutMs: 180_000,
      });
      editorRef.current = editor;
      const loaded = await loadEditorFileWithoutDialogs(editor, uploadedBytes.slice(), file.name);
      const protocol = resolveStudioDocumentAgentProtocol(editor);
      if (!protocol) {
        throw new Error("현재 @rhwp/editor에 public document-agent command capability가 없어 Phase 0 native gate를 숨깁니다.");
      }
      const bytes = await exportVerifiedEditorDocument(editor, format);
      const state = await protocol.getDocumentState();
      const exportedSha256 = await sha256Hex(bytes);
      if (state.format !== format || state.documentSha256 !== exportedSha256) {
        throw new Error("초기 Studio document state와 검증 export SHA가 다릅니다.");
      }
      protocolRef.current = protocol;
      transactionRef.current = createStudioCommandDocumentAgentTransaction({
        rhwp,
        protocol,
        exportCurrentBytes: (currentFormat) => exportVerifiedEditorDocument(editor, currentFormat),
      });
      setStatus("scanning");
      setMessage("Studio의 검증 export에서 안전 후보를 찾고 있습니다.");
      const document = new rhwp.HwpDocument(bytes);
      let sourceManifest: DocumentAgentSemanticManifest;
      let sourceSha256: string;
      let pageCount: number;
      let candidates: DocumentEditCandidate[] = [];
      let scanMs = 0;
      try {
        [sourceManifest, sourceSha256] = await Promise.all([
          buildDocumentAgentSemanticManifest(document),
          sha256Hex(bytes),
        ]);
        pageCount = document.pageCount();
        for (let page = 1; page <= pageCount; page += 1) {
          const startedAt = performance.now();
          const pageCandidates = await extractDocumentEditCandidates({
            document,
            sourceKey: `phase0:${format}:${sourceSha256}`,
            documentSha256: sourceSha256,
            selectedPage: page,
            reservedAnchors: [],
          });
          const elapsed = performance.now() - startedAt;
          scanMs = Math.max(scanMs, elapsed);
          if (elapsed >= 2_000) {
            throw new Error(`candidate scan이 ${elapsed.toFixed(1)}ms로 2초 상한을 넘었습니다.`);
          }
          candidates = [...candidates, ...pageCandidates];
          if (candidates[0]) break;
        }
      } finally {
        document.free();
      }
      const candidate = candidates[0];
      if (!candidate) throw new Error(`${format.toUpperCase()} 실문서에서 안전 후보가 0개입니다.`);
      if (!candidateLocationUseful(candidate)) {
        throw new Error(`${format.toUpperCase()} 실문서 후보의 위치 설명이 충분하지 않습니다.`);
      }
      const nextSource: SourceState = {
        bytes,
        format,
        filename: file.name,
        sourceKey: candidate.sourceKey,
        sourceSha256,
        pageCount,
        sourceManifest,
        candidate,
        scanMs,
        candidateCount: candidates.length,
      };
      sourceRef.current = nextSource;
      setSource(nextSource);
      if (loaded.pageCount !== pageCount) {
        throw new Error(`초기 Studio page count가 core ${pageCount}쪽과 Studio ${loaded.pageCount}쪽으로 다릅니다.`);
      }
      setStatus("ready");
      setMessage("public command capability와 후보 준비 완료. native apply/revert 게이트를 실행하세요.");
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  const runAgentGate = useCallback(async () => {
    const editor = editorRef.current;
    const rhwp = rhwpRef.current;
    const protocol = protocolRef.current;
    const transaction = transactionRef.current;
    const current = sourceRef.current;
    if (!editor || !rhwp || !protocol || !transaction || !current) return;
    setStatus("running");
    setMessage("native apply → receipt/export 검증 → focus → native revert를 실행하고 있습니다.");
    let unsubscribe: () => void = () => undefined;
    try {
      const replacement = sameLengthReplacement(current.candidate.beforeText);
      const events: string[] = [];
      unsubscribe = protocol.onDocumentChanged((event) => {
        events.push(`${event.reason}:${event.commandId}:${event.changeSeq}`);
      });
      const applyStartedAt = performance.now();
      const applied = await transaction.apply({
        bytes: current.bytes,
        format: current.format,
        reservedAnchors: [],
        command: {
          schemaVersion: "document-agent-v1",
          candidate: current.candidate,
          replacement,
        },
      });
      const applyCommandMs = performance.now() - applyStartedAt;
      const undone = await transaction.undo({
        bytes: applied.bytes,
        format: current.format,
        reservedAnchors: [],
        command: {
          schemaVersion: "document-agent-v1",
          candidate: current.candidate,
          afterText: replacement,
        },
      });
      const finalBytes = await exportVerifiedEditorDocument(editor, current.format);
      const finalDocument = new rhwp.HwpDocument(finalBytes);
      let finalManifest: DocumentAgentSemanticManifest;
      try {
        finalManifest = await buildDocumentAgentSemanticManifest(finalDocument);
      } finally {
        finalDocument.free();
      }
      assertDocumentAgentManifestsEqual(undone.afterManifest, finalManifest);
      const targetBefore = paragraphAt(current.sourceManifest, current.candidate);
      const targetFinal = paragraphAt(finalManifest, current.candidate);
      if (canonicalJson(targetBefore) !== canonicalJson(targetFinal)) {
        throw new Error("Undo 뒤 target text/format이 before와 exact 일치하지 않습니다.");
      }
      assertDocumentAgentManifestsEqual(current.sourceManifest, finalManifest, "native revert 뒤 전체 문서가 source와 다릅니다.");
      if (applyCommandMs >= 3_000) {
        throw new Error(`native apply가 ${applyCommandMs.toFixed(1)}ms로 3초 상한을 넘었습니다.`);
      }
      const pageCountStable = [
        applied.beforeManifest.pageCount,
        applied.afterManifest.pageCount,
        undone.beforeManifest.pageCount,
        undone.afterManifest.pageCount,
        finalManifest.pageCount,
      ].every((value) => value === current.pageCount);
      if (!pageCountStable) throw new Error("apply/Undo 전후 page count가 달라졌습니다.");
      if (events.length !== 2 || !events[0]?.startsWith("agent_apply:") || !events[1]?.startsWith("agent_revert:")) {
        throw new Error(`documentChanged event가 apply/revert 각 1회가 아닙니다: ${events.join(", ")}`);
      }
      const selection = await protocol.getSelectionContext();
      await notifyEditorSaved(editor);
      setGate({
        format: current.format,
        candidateScanMs: current.scanMs,
        candidateCount: current.candidateCount,
        candidateLocationUseful: true,
        applyCommandMs,
        applyWithinThreeSeconds: true,
        applyExportReopen: true,
        pageCountStable,
        nonTargetSemanticStable: true,
        studioReexportSemanticStable: true,
        undoExact: true,
        applyFocused: applied.focus.focused,
        undoFocused: undone.focus.focused,
        selectionEditableAfterUndo: selection.editable,
        documentChangedEvents: events,
        commandReloadCount: 0,
        repeatedModalRiskRemoved: true,
      });
      setStatus("agent_pass");
      setMessage("Studio native apply/revert와 receipt/export/focus/event 게이트가 통과했습니다.");
    } catch (error) {
      fail(error);
    } finally {
      unsubscribe();
    }
  }, [fail]);

  const startRegression = useCallback(() => {
    editorRef.current?.destroy();
    editorRef.current = null;
    regressionRef.current = EMPTY_REGRESSION;
    setRegression(EMPTY_REGRESSION);
    setShowRegression(true);
    setStatus("regression_loading");
    setMessage("실제 RhwpStudioSurface를 로드하고 있습니다.");
  }, []);

  const regressionDocument = useMemo<RhwpWorkingDocument | null>(() => source ? ({
    sourceKey: source.sourceKey,
    bytes: source.bytes,
    format: source.format,
    filename: source.filename,
    revisionId: null,
    serverSavedAt: null,
    materializedAnswers: {},
    skipped: [],
  }) : null, [source]);

  const onSurfaceSaved = useCallback(async (document: RhwpWorkingDocument, _fieldId: string | null, returnToQuick: boolean) => {
    const current = sourceRef.current;
    const rhwp = rhwpRef.current;
    if (!current || !rhwp) return;
    try {
      const reopened = new rhwp.HwpDocument(document.bytes);
      let manifest: DocumentAgentSemanticManifest;
      try {
        manifest = await buildDocumentAgentSemanticManifest(reopened);
      } finally {
        reopened.free();
      }
      const next: Partial<RegressionState> = {
        saveCount: regressionRef.current.saveCount + 1,
        semanticInputChanged: canonicalJson(manifest) !== canonicalJson(current.sourceManifest),
      };
      const probe = (window as typeof window & { __phase0DownloadProbe?: { count: number } }).__phase0DownloadProbe;
      if (probe?.count) next.downloadIntercepted = true;
      if (returnToQuick) {
        next.returnedToQuick = true;
        setShowRegression(false);
        setStatus("quick_returned");
        setMessage("실제 RhwpStudioSurface가 저장 callback 뒤 빠른 작성으로 복귀했습니다.");
      } else {
        setStatus("regression_ready");
        setMessage("수동 저장 callback을 받았습니다. 입력 변경·download probe를 확인하세요.");
      }
      updateRegression(next);
    } catch (error) {
      updateRegression({ error: error instanceof Error ? error.message : String(error) });
      fail(error);
    }
  }, [fail, updateRegression]);

  return (
    <main style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>Document Agent Phase 0 Browser Gate</h1>
      <p data-testid="status"><strong>{status}</strong> — {message}</p>
      <input
        aria-label="Phase 0 실문서"
        type="file"
        accept=".hwp,.hwpx"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void loadFile(file);
        }}
      />
      {status === "ready" ? (
        <button type="button" onClick={() => void runAgentGate()} style={{ marginLeft: 8 }}>
          native apply/export/revert 실행
        </button>
      ) : null}
      {status === "agent_pass" ? (
        <button type="button" onClick={startRegression} style={{ marginLeft: 8 }}>
          실제 RhwpStudioSurface 회귀 열기
        </button>
      ) : null}
      {status === "quick_returned" ? (
        <button type="button" onClick={startRegression} style={{ marginLeft: 8 }}>
          문서 직접 편집 재진입
        </button>
      ) : null}
      <pre data-testid="gate-result">{gate ? JSON.stringify(gate, null, 2) : "gate result: pending"}</pre>
      <pre data-testid="regression-result">{JSON.stringify(regression, null, 2)}</pre>
      {showRegression && regressionDocument && source ? (
        <div style={{ minHeight: "80vh", border: "2px solid #2563eb", marginTop: 12 }}>
          <RhwpStudioSurface
            key={`surface:${source.sourceSha256}`}
            transport={{ mode: "local_preview", sourceKey: source.sourceKey, sourceUrl: "/unused" }}
            answers={{}}
            quickFields={[]}
            connectedFields={[]}
            manualAnchors={[]}
            duplicateLabels={new Set<string>()}
            workingDocument={regressionDocument}
            headMaterializedAnswers={{}}
            activeTask={null}
            onSaved={onSurfaceSaved}
          />
        </div>
      ) : (
        <div
          ref={directContainerRef}
          aria-label="Phase 0 direct Studio"
          style={{ width: "100%", height: "75vh", border: "2px solid #111", marginTop: 12 }}
        />
      )}
    </main>
  );
}

function documentFormat(filename: string): RhwpDocumentFormat {
  if (/\.hwpx$/iu.test(filename)) return "hwpx";
  if (/\.hwp$/iu.test(filename)) return "hwp";
  throw new Error("HWP/HWPX 파일만 사용할 수 있습니다.");
}

function candidateLocationUseful(candidate: DocumentEditCandidate): boolean {
  const box = candidate.location.box;
  return candidate.location.page > 0
    && candidate.location.label.trim().length > 0
    && Boolean(box)
    && [box?.x, box?.y, box?.width, box?.height].every((value) => typeof value === "number" && Number.isFinite(value))
    && (box?.width ?? 0) > 0
    && (box?.height ?? 0) > 0;
}

function sameLengthReplacement(value: string): string {
  const chars = [...value];
  const index = chars.findIndex((char) => !/\s/u.test(char));
  if (index < 0) throw new Error("치환할 non-whitespace 문자를 찾지 못했습니다.");
  chars[index] = chars[index]!.length === 1 ? (chars[index] === "검" ? "증" : "검") : "😀";
  const replacement = chars.join("");
  if (replacement.length !== value.length || replacement === value) {
    throw new Error("동일 길이 브라우저 검증 치환문을 만들지 못했습니다.");
  }
  return replacement;
}

function paragraphAt(manifest: DocumentAgentSemanticManifest, candidate: DocumentEditCandidate) {
  const paragraph = manifest.paragraphs.find((entry) => (
    entry.section === candidate.anchor.section && entry.paragraph === candidate.anchor.paragraph
  ));
  if (!paragraph) throw new Error("semantic manifest에서 target 문단을 찾지 못했습니다.");
  return paragraph;
}

declare global {
  interface Window {
    __phase0DownloadProbe?: { count: number };
  }
}

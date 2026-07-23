"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";
import { loadRhwp, type RhwpDocument } from "@/lib/rhwp/client";
import {
  resolveRhwpFieldAnchors,
  resolveRhwpCellAtPoint,
  type RhwpFieldAnchor,
  type RhwpFieldDescriptor,
} from "@/lib/rhwp/fieldAnchors";

type RhwpSurfaceState =
  | { status: "loading" }
  | { status: "ready"; imageUrl: string }
  | { status: "fallback" };

/**
 * 원본 HWP/HWPX를 한 번 파싱하고 현재 페이지만 안전한 SVG object URL로 렌더한다.
 * SVG 문자열을 DOM에 삽입하지 않아 문서 유래 스크립트가 실행될 여지를 막는다.
 */
export function RhwpPageSurface({
  sourceUrl,
  pageIndex,
  fields,
  alt,
  fallbackSrc,
  onLoad,
  onReady,
  onFallback,
  locatingField,
  onLocate,
}: {
  sourceUrl: string;
  pageIndex: number;
  fields: readonly RhwpFieldDescriptor[];
  alt: string;
  fallbackSrc?: string | null;
  onLoad?: () => void;
  onReady?: (result: { pageCount: number; anchors: RhwpFieldAnchor[] }) => void;
  onFallback?: () => void;
  locatingField?: RhwpFieldDescriptor | null;
  onLocate?: (anchor: RhwpFieldAnchor) => void;
}) {
  const [state, setState] = useState<RhwpSurfaceState>({ status: "loading" });
  const documentRef = useRef<RhwpDocument | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const imageRef = useRef<HTMLImageElement>(null);

  function replaceImageUrl(next: string | null): void {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = next;
  }

  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestRef.current;
    setState({ status: "loading" });

    void (async () => {
      try {
        const [response, rhwp] = await Promise.all([
          fetch(sourceUrl, { signal: controller.signal, cache: "no-store" }),
          loadRhwp(),
        ]);
        if (!response.ok) throw new Error(`원본 문서 응답 ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (controller.signal.aborted || requestRef.current !== request) return;
        const document = new rhwp.HwpDocument(bytes);
        documentRef.current?.free();
        documentRef.current = document;
        const pageCount = document.pageCount();
        const anchors = resolveRhwpFieldAnchors(document, fields);
        onReady?.({ pageCount, anchors });
        if (pageIndex >= pageCount) throw new Error("rhwp 문서의 페이지 범위를 벗어났습니다.");
        const svg = document.renderPageSvg(pageIndex);
        const imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        if (controller.signal.aborted || requestRef.current !== request) {
          URL.revokeObjectURL(imageUrl);
          return;
        }
        replaceImageUrl(imageUrl);
        setState({ status: "ready", imageUrl });
      } catch (error) {
        if (controller.signal.aborted || requestRef.current !== request) return;
        console.warn("[rhwp-preview] 이미지 프리뷰로 폴백", error);
        onFallback?.();
        setState({ status: "fallback" });
      }
    })();

    return () => {
      controller.abort();
      documentRef.current?.free();
      documentRef.current = null;
      replaceImageUrl(null);
    };
  }, [sourceUrl, fields, onReady, onFallback]);

  useEffect(() => {
    const document = documentRef.current;
    if (!document || state.status === "fallback") return;
    let imageUrl: string | null = null;
    try {
      const svg = document.renderPageSvg(pageIndex);
      imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      replaceImageUrl(imageUrl);
      setState({ status: "ready", imageUrl });
    } catch (error) {
      console.warn("[rhwp-preview] 페이지 렌더 실패로 폴백", error);
      onFallback?.();
      setState({ status: "fallback" });
    }
    return () => {
      if (imageUrlRef.current === imageUrl) replaceImageUrl(null);
    };
  }, [pageIndex, onFallback]);

  // rhwp가 준비되는 동안에도 기존 서버 이미지를 즉시 보여 화면·SSR·접근성 계약을 유지한다.
  const src = state.status === "ready" ? state.imageUrl : fallbackSrc;
  if (!src) return null;

  function handleLocate(event: ReactMouseEvent<HTMLDivElement>): void {
    const document = documentRef.current;
    const image = imageRef.current;
    if (!document || !image || !locatingField || state.status !== "ready") return;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    try {
      const page = JSON.parse(document.getPageInfo(pageIndex)) as { width?: unknown; height?: unknown };
      if (typeof page.width !== "number" || typeof page.height !== "number") return;
      const anchor = resolveRhwpCellAtPoint({
        document,
        field: locatingField,
        pageIndex,
        x: (event.clientX - rect.left) / rect.width * page.width,
        y: (event.clientY - rect.top) / rect.height * page.height,
      });
      if (anchor) onLocate?.(anchor);
    } catch {
      // 셀이 아닌 곳은 아무 것도 변경하지 않는다.
    }
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <div
      className={cn("relative", locatingField && state.status === "ready" && "cursor-crosshair")}
      onClick={handleLocate}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        className="pointer-events-none block w-full select-none"
        draggable={false}
        onLoad={onLoad}
      />
      {locatingField && state.status === "ready" ? (
        <div className="pointer-events-none absolute inset-x-3 top-3 rounded-md bg-foreground/85 px-3 py-2 text-center text-xs font-medium text-background shadow-sm">
          ‘{locatingField.label}’ 값을 넣을 표 셀을 눌러 주세요.
        </div>
      ) : null}
    </div>
  );
}

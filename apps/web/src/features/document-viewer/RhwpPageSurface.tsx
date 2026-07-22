"use client";

import { useEffect, useRef, useState } from "react";
import { loadRhwp, type RhwpDocument } from "@/lib/rhwp/client";

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
  expectedPageCount,
  alt,
  fallbackSrc,
  onLoad,
}: {
  sourceUrl: string;
  pageIndex: number;
  expectedPageCount: number;
  alt: string;
  fallbackSrc: string;
  onLoad?: () => void;
}) {
  const [state, setState] = useState<RhwpSurfaceState>({ status: "loading" });
  const documentRef = useRef<RhwpDocument | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const requestRef = useRef(0);

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
        if (document.pageCount() !== expectedPageCount) {
          document.free();
          throw new Error("rhwp와 변환 프리뷰의 페이지 수가 다릅니다.");
        }
        documentRef.current?.free();
        documentRef.current = document;
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
        setState({ status: "fallback" });
      }
    })();

    return () => {
      controller.abort();
      documentRef.current?.free();
      documentRef.current = null;
      replaceImageUrl(null);
    };
  }, [sourceUrl, expectedPageCount]);

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
      setState({ status: "fallback" });
    }
    return () => {
      if (imageUrlRef.current === imageUrl) replaceImageUrl(null);
    };
  }, [pageIndex]);

  // rhwp가 준비되는 동안에도 기존 서버 이미지를 즉시 보여 화면·SSR·접근성 계약을 유지한다.
  const src = state.status === "ready" ? state.imageUrl : fallbackSrc;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={alt}
      className="pointer-events-none block w-full select-none"
      draggable={false}
      onLoad={onLoad}
    />
  );
}

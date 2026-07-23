import type * as Rhwp from "@rhwp/core";

export type RhwpModule = typeof Rhwp;
export type RhwpDocument = InstanceType<RhwpModule["HwpDocument"]>;
export type RhwpDocumentFormat = "hwp" | "hwpx";

let rhwpModulePromise: Promise<RhwpModule> | null = null;

/** rhwp WASM은 브라우저에서 필요할 때 한 번만 초기화한다. */
export function loadRhwp(): Promise<RhwpModule> {
  if (!rhwpModulePromise) {
    rhwpModulePromise = (async () => {
      const scope = globalThis as typeof globalThis & {
        measureTextWidth?: (font: string, text: string) => number;
      };
      if (typeof window !== "undefined" && !scope.measureTextWidth) {
        const canvas = window.document.createElement("canvas");
        const context = canvas.getContext("2d");
        let currentFont = "";
        scope.measureTextWidth = (font, text) => {
          if (!context) return text.length * 8;
          if (font !== currentFont) {
            context.font = font;
            currentFont = font;
          }
          return context.measureText(text).width;
        };
      }
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

export interface RhwpExportVerification {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  pageCountBefore: number;
  pageCountAfter: number;
}

interface HwpVerifyResult {
  bytesLen: number;
  pageCountBefore: number;
  pageCountAfter: number;
  recovered: boolean;
}

function parseHwpVerification(value: string): HwpVerifyResult {
  const parsed = JSON.parse(value) as Partial<HwpVerifyResult>;
  if (
    typeof parsed.bytesLen !== "number"
    || typeof parsed.pageCountBefore !== "number"
    || typeof parsed.pageCountAfter !== "number"
    || typeof parsed.recovered !== "boolean"
  ) {
    throw new Error("rhwp HWP 검증 결과를 해석하지 못했습니다.");
  }
  return parsed as HwpVerifyResult;
}

/** 실제 다운로드 바이트를 새 문서로 다시 열어 원본 형식별 무결성을 검증한다. */
export function exportVerifiedRhwpDocument(input: {
  rhwp: RhwpModule;
  document: RhwpDocument;
  format: RhwpDocumentFormat;
}): RhwpExportVerification {
  const pageCountBefore = input.document.pageCount();
  let bytes: Uint8Array;

  if (input.format === "hwp") {
    const verification = parseHwpVerification(input.document.exportHwpVerify());
    if (!verification.recovered) {
      throw new Error("rhwp가 내보낸 HWP를 다시 열지 못해 다운로드를 차단했습니다.");
    }
    if (verification.pageCountBefore !== verification.pageCountAfter) {
      throw new Error("HWP 자기 검증에서 페이지 수가 달라져 다운로드를 차단했습니다.");
    }
    bytes = input.document.exportHwp();
    if (bytes.byteLength !== verification.bytesLen) {
      throw new Error("HWP 검증본과 실제 다운로드본의 크기가 달라 다운로드를 차단했습니다.");
    }
  } else {
    bytes = input.document.exportHwpx();
  }

  if (bytes.byteLength === 0) throw new Error("rhwp가 빈 파일을 만들어 다운로드를 차단했습니다.");

  const reopened = new input.rhwp.HwpDocument(bytes);
  let pageCountAfter: number;
  try {
    pageCountAfter = reopened.pageCount();
  } finally {
    reopened.free();
  }
  if (pageCountBefore !== pageCountAfter) {
    throw new Error(
      `내보낸 ${input.format.toUpperCase()}를 다시 열었을 때 페이지 수가 ${pageCountBefore}쪽에서 ${pageCountAfter}쪽으로 달라졌습니다.`,
    );
  }
  return { bytes, format: input.format, pageCountBefore, pageCountAfter };
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

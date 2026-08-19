import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RhwpModule } from "@/lib/rhwp/client";

let corePromise: Promise<RhwpModule> | null = null;

/** Node route에서만 호출한다. Edge/browser import 경로에는 이 모듈을 넣지 않는다. */
export function loadDocumentAgentCore(): Promise<RhwpModule> {
  if (!corePromise) {
    corePromise = initializeDocumentAgentCore();
    corePromise.catch(() => {
      corePromise = null;
    });
  }
  return corePromise;
}

export function resolveDocumentAgentCoreRuntimeFiles(): { modulePath: string; wasmPath: string } {
  // Turbopack rewrites this module's `import.meta.url` to a virtual `[project]`
  // path. Resolving the sidecar WASM from that URL works in plain Node tests but
  // produces an ENOENT in the Next.js route runtime. Anchor resolution to the
  // actual runtime working directory instead; both local Next.js and Vercel run
  // with the application package reachable from this package.json boundary.
  const require = createRequire(join(process.cwd(), "package.json"));
  const modulePath = require.resolve("@rhwp/core");
  return { modulePath, wasmPath: join(dirname(modulePath), "rhwp_bg.wasm") };
}

async function initializeDocumentAgentCore(): Promise<RhwpModule> {
  const scope = globalThis as typeof globalThis & {
    measureTextWidth?: (font: string, text: string) => number;
  };
  if (!scope.measureTextWidth) {
    // Node에는 Canvas/font stack이 없으므로 후보 ID에 포함되지 않는 layout 계산만 보수적인
    // deterministic 폭으로 제공한다. 실제 쪽 일치는 Phase 0 실문서 gate에서 별도 검증한다.
    scope.measureTextWidth = (_font, text) => [...text].length * 8;
  }
  const [{ wasmPath }, module] = await Promise.all([
    Promise.resolve(resolveDocumentAgentCoreRuntimeFiles()),
    import("@rhwp/core"),
  ]);
  const wasmBytes = readFileSync(wasmPath);
  module.initSync({
    module: wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ) as ArrayBuffer,
  });
  module.init_panic_hook();
  return module;
}

// hwp2hwpx 트랙 Phase 1 — .hwp 바이너리 → .hwpx 변환 + STORE 재포장 정규화.
//
// 변환기: neolord0/hwp2hwpx (커밋 핀) uber jar. Dockerfile 멀티스테이지(maven) 빌드가
//   런타임 스테이지에 jar 를 COPY 하고 HWP2HWPX_JAR 로 경로를 노출한다.
// 재포장: @cunote/core/documents/hwpx-fill 의 readHwpxEntries → writeHwpx.
//   Phase 0 실측 결함(hwp2hwpx 가 mimetype 을 DEFLATE 로 저장 — OWPML 표준은 STORE 필수)을
//   writeHwpx 가 mimetype STORE 첫 엔트리로 정규화한다.
//
// 비치명 계약: 변환 실패는 분류된 outcome 으로 보고하되 예외를 던지지 않는다.
//   (pdf/page_image/markdown 등 다른 artifact 생성을 막지 않는다 — 정직 실패.)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectHwpFormat,
  readHwpxEntries,
  writeHwpx,
} from "@cunote/core/documents/hwpx-fill";
import type { HwpxConversionResult } from "./types.js";
import type { HwpxConvertFn } from "./convert-document.js";

/** 런타임 스테이지의 jar 기본 경로 (Dockerfile ENV HWP2HWPX_JAR 와 정합). */
export const DEFAULT_HWP2HWPX_JAR = "/opt/hwp2hwpx/hwp2hwpx-cli.jar";
export const DEFAULT_HWP2HWPX_TIMEOUT_MS = 120_000;

function resolveJarPath(explicit?: string): string {
  return explicit ?? process.env.HWP2HWPX_JAR ?? DEFAULT_HWP2HWPX_JAR;
}

function resolveJavaBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.HWP2HWPX_JAVA_BIN) return process.env.HWP2HWPX_JAVA_BIN;
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

/** java stderr("ERR <class>: <msg>") 를 분류. 근거 부족 시 conversion_error. */
function classifyError(stderr: string): HwpxConversionResult["outcome"] {
  const s = stderr.toLowerCase();
  if (/password|encrypt|암호/.test(s)) return "encrypted";
  if (/distribut|배포/.test(s)) return "distribution";
  if (/not.*hwp|hwp.*3\.|version|signature|invalid.*file|올바른.*아/.test(s)) {
    return "hwp_v3x";
  }
  return "conversion_error";
}

/**
 * hwp 바이너리 1건을 hwpx 로 변환하고 STORE 재포장 정규화한다.
 * 매직 바이트가 hwp 바이너리(D0CF11E0)가 아니면 변환하지 않고 스킵 사유를 기록한다.
 */
export function convertHwpToHwpx(input: {
  body: Buffer;
  workDir: string;
  jarPath?: string;
  javaBin?: string;
  timeoutMs?: number;
}): HwpxConversionResult {
  // 매직 바이트 판별 — 확장자 위장 대응(설계 5번). PK 면 이미 hwpx → 변환 불필요.
  const fmt = detectHwpFormat(input.body);
  if (fmt === "hwpx") {
    return {
      outcome: "skipped_already_hwpx",
      artifact: null,
      reason: "input is already hwpx (PK)",
    };
  }
  if (fmt !== "hwp-binary") {
    return {
      outcome: "skipped_not_hwp_binary",
      artifact: null,
      reason: `magic bytes not hwp-binary (${fmt})`,
    };
  }

  const jar = resolveJarPath(input.jarPath);
  if (!existsSync(jar)) {
    return {
      outcome: "converter_unavailable",
      artifact: null,
      reason: `hwp2hwpx jar not found: ${jar}`,
    };
  }

  const inPath = join(input.workDir, "hwp2hwpx-in.hwp");
  const outPath = join(input.workDir, "hwp2hwpx-out.hwpx");
  writeFileSync(inPath, input.body);

  const timeoutMs = input.timeoutMs ?? DEFAULT_HWP2HWPX_TIMEOUT_MS;
  const proc = spawnSync(
    resolveJavaBin(input.javaBin),
    ["-jar", jar, inPath, outPath],
    { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] },
  );

  if (proc.error) {
    const killed = (proc as { signal?: string }).signal === "SIGTERM";
    if (killed) {
      return {
        outcome: "timeout",
        artifact: null,
        reason: `hwp2hwpx timeout (>${timeoutMs}ms)`,
      };
    }
    return {
      outcome: "converter_unavailable",
      artifact: null,
      reason: `java spawn error: ${proc.error.message}`,
    };
  }

  const stderr = String(proc.stderr ?? "");
  if (proc.status !== 0) {
    return {
      outcome: classifyError(stderr),
      artifact: null,
      reason: stderr.trim().slice(0, 500) || `java exit ${proc.status}`,
    };
  }
  if (!existsSync(outPath)) {
    return {
      outcome: "conversion_error",
      artifact: null,
      reason: "java exited 0 but produced no hwpx output",
    };
  }

  // STORE 재포장 정규화 (mimetype DEFLATE → STORE 첫 엔트리). core 로직 재사용.
  try {
    const raw = readFileSync(outPath);
    const repacked = writeHwpx(readHwpxEntries(raw));
    const repackPath = join(input.workDir, "hwp2hwpx-normalized.hwpx");
    writeFileSync(repackPath, repacked);
    return {
      outcome: "converted",
      artifact: { path: repackPath, bytes: repacked.length },
      reason: null,
    };
  } catch (err) {
    return {
      outcome: "repack_failed",
      artifact: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** convertDocument 에 주입할 어댑터 (env 기반 jar/java 경로 사용). */
export const hwpxConvert: HwpxConvertFn = ({ body, workDir }) =>
  convertHwpToHwpx({ body, workDir });

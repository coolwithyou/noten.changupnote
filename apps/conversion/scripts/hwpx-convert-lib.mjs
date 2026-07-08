// src/hwpx-convert.ts 의 plain-node 미러 (샌드박스/로컬 검증용).
// TS 소스가 정본. 로직을 바꾸면 두 곳을 함께 갱신한다 (README 관례).
//
// core 재포장 로직은 빌드된 dist 에서 로드한다 (packages/core/dist).
// convert-lib.mjs 는 core 를 import 하지 않으므로(quality-test 영향 방지),
// hwpx 검증이 필요한 스크립트만 이 파일을 import 한다.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectHwpFormat,
  readHwpxEntries,
  writeHwpx,
} from "../../../packages/core/dist/documents/hwpx-fill.js";

export const DEFAULT_HWP2HWPX_JAR = "/opt/hwp2hwpx/hwp2hwpx-cli.jar";
export const DEFAULT_HWP2HWPX_TIMEOUT_MS = 120_000;

function resolveJarPath(explicit) {
  return explicit ?? process.env.HWP2HWPX_JAR ?? DEFAULT_HWP2HWPX_JAR;
}
function resolveJavaBin(explicit) {
  if (explicit) return explicit;
  if (process.env.HWP2HWPX_JAVA_BIN) return process.env.HWP2HWPX_JAVA_BIN;
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

function classifyError(stderr) {
  const s = stderr.toLowerCase();
  if (/password|encrypt|암호/.test(s)) return "encrypted";
  if (/distribut|배포/.test(s)) return "distribution";
  if (/not.*hwp|hwp.*3\.|version|signature|invalid.*file|올바른.*아/.test(s)) return "hwp_v3x";
  return "conversion_error";
}

export function convertHwpToHwpx(input) {
  const fmt = detectHwpFormat(input.body);
  if (fmt === "hwpx") return { outcome: "skipped_already_hwpx", artifact: null, reason: "input is already hwpx (PK)" };
  if (fmt !== "hwp-binary") return { outcome: "skipped_not_hwp_binary", artifact: null, reason: `magic bytes not hwp-binary (${fmt})` };

  const jar = resolveJarPath(input.jarPath);
  if (!existsSync(jar)) return { outcome: "converter_unavailable", artifact: null, reason: `hwp2hwpx jar not found: ${jar}` };

  const inPath = join(input.workDir, "hwp2hwpx-in.hwp");
  const outPath = join(input.workDir, "hwp2hwpx-out.hwpx");
  writeFileSync(inPath, input.body);

  const timeoutMs = input.timeoutMs ?? DEFAULT_HWP2HWPX_TIMEOUT_MS;
  const proc = spawnSync(resolveJavaBin(input.javaBin), ["-jar", jar, inPath, outPath], {
    encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
  });

  if (proc.error) {
    const killed = proc.signal === "SIGTERM";
    if (killed) return { outcome: "timeout", artifact: null, reason: `hwp2hwpx timeout (>${timeoutMs}ms)` };
    return { outcome: "converter_unavailable", artifact: null, reason: `java spawn error: ${proc.error.message}` };
  }

  const stderr = String(proc.stderr ?? "");
  if (proc.status !== 0) {
    return { outcome: classifyError(stderr), artifact: null, reason: stderr.trim().slice(0, 500) || `java exit ${proc.status}` };
  }
  if (!existsSync(outPath)) {
    return { outcome: "conversion_error", artifact: null, reason: "java exited 0 but produced no hwpx output" };
  }

  try {
    const raw = readFileSync(outPath);
    const repacked = writeHwpx(readHwpxEntries(raw));
    const repackPath = join(input.workDir, "hwp2hwpx-normalized.hwpx");
    writeFileSync(repackPath, repacked);
    return { outcome: "converted", artifact: { path: repackPath, bytes: repacked.length }, reason: null };
  } catch (err) {
    return { outcome: "repack_failed", artifact: null, reason: err?.message ?? String(err) };
  }
}

/** convertDocument(mirror) 에 주입할 어댑터 팩토리 (jar/java/timeout 바인딩). */
export function makeHwpxConvert(opts = {}) {
  return ({ body, workDir }) => convertHwpToHwpx({ body, workDir, ...opts });
}

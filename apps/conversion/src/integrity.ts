// T2 · 1단계: 무결성 확인.
// 계획 5장 1단계 + 11장 리스크(암호화/대용량/sha256 불일치)

import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { DocumentFormat } from "./types.js";

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

export interface IntegrityResult {
  sha256: string;
  format: DocumentFormat | null;
  encrypted: boolean;
  oversize: boolean;
  sha256Mismatch: boolean;
  /** 즉시 failed 로 만드는 치명 사유. 없으면 통과. */
  fatalReason: string | null;
  warnings: string[];
}

/** 확장자 기반 포맷 판정. */
export function detectFormat(filename: string): DocumentFormat | null {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".hwp":
      return "hwp";
    case ".hwpx":
      return "hwpx";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    default:
      return null;
  }
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * HWP 5.0 (OLE/CFB) FileHeader의 암호 플래그 탐지.
 * CFB 시그니처(D0CF11E0) 확인 후, "HWP Document File" 스트림의 속성 비트를 검사.
 * 정밀 파싱 대신, 널리 쓰이는 휴리스틱: FileHeader 시그니처 이후 version(4B) 다음
 * 속성 DWORD의 bit1(0x02)이 암호화 플래그.
 * OLE 파싱 없이 raw 버퍼에서 "HWP Document File" ASCII 시그니처를 찾아 그 뒤 속성을 읽는다.
 */
export function isHwpEncrypted(buffer: Buffer): boolean {
  // CFB 매직
  const cfbMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(cfbMagic)) return false;
  // FileHeader 스트림 시그니처: "HWP Document File" (17 bytes) + padding to 32
  const sig = Buffer.from("HWP Document File", "ascii");
  const idx = buffer.indexOf(sig);
  if (idx < 0) return false;
  // 시그니처 32B + version 4B 이후에 속성 DWORD (little-endian)
  const propOffset = idx + 32 + 4;
  if (propOffset + 4 > buffer.length) return false;
  const props = buffer.readUInt32LE(propOffset);
  // bit1 (0x02) = 암호 설정
  return (props & 0x02) !== 0;
}

/** HWPX(zip) 암호화 탐지: OWPML은 zip. 표준 zip 암호 플래그(로컬헤더 general purpose bit0). */
export function isHwpxEncrypted(buffer: Buffer): boolean {
  // zip local file header magic 0x04034b50
  if (buffer.length < 8) return false;
  if (buffer.readUInt32LE(0) !== 0x04034b50) return false;
  const gpFlag = buffer.readUInt16LE(6);
  return (gpFlag & 0x0001) !== 0;
}

/** PDF 암호화 탐지: 문서 내 /Encrypt 키 존재. */
export function isPdfEncrypted(buffer: Buffer): boolean {
  // %PDF 시그니처 확인
  if (buffer.subarray(0, 4).toString("ascii") !== "%PDF") return false;
  // trailer 부근에 /Encrypt 가 있으면 암호화. 전체 스캔(간단·안전).
  return buffer.includes(Buffer.from("/Encrypt", "ascii"));
}

export function checkIntegrity(input: {
  body: Buffer;
  filename: string;
  expectedSha256?: string | undefined;
  maxBytes?: number | undefined;
}): IntegrityResult {
  const warnings: string[] = [];
  const sha256 = sha256Hex(input.body);
  const format = detectFormat(input.filename);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  let fatalReason: string | null = null;

  // sha256 대조
  const sha256Mismatch =
    input.expectedSha256 != null &&
    input.expectedSha256.length > 0 &&
    input.expectedSha256.toLowerCase() !== sha256.toLowerCase();
  if (sha256Mismatch) {
    warnings.push("sha256_mismatch");
    fatalReason = fatalReason ?? "sha256_mismatch";
  }

  // 크기 상한
  const oversize = input.body.length > maxBytes;
  if (oversize) {
    warnings.push("oversize_source");
    fatalReason = fatalReason ?? "oversize_source";
  }

  // 암호화 탐지
  let encrypted = false;
  if (format === "hwp") encrypted = isHwpEncrypted(input.body);
  else if (format === "hwpx") encrypted = isHwpxEncrypted(input.body);
  else if (format === "pdf") encrypted = isPdfEncrypted(input.body);
  if (encrypted) {
    warnings.push("encrypted_source");
    fatalReason = fatalReason ?? "encrypted_source";
  }

  if (format === null) {
    warnings.push("unsupported_format");
    fatalReason = fatalReason ?? "unsupported_format";
  }

  return { sha256, format, encrypted, oversize, sha256Mismatch, fatalReason, warnings };
}

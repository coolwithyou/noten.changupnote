// T9 실패 경로 픽스처 생성기.
// 계획 11장(암호화/타임아웃/부분성공/대용량/무결성)의 실패 유형을 재현하는 합성 샘플을
// 결정론적으로 만든다. 실HWP 는 spike-samples 에서 가져오고, 손상/암호화/이미지전용은 합성한다.
// 합성 방법은 각 함수 주석에 명시(보고서에도 기재).
//
// 사용: import { buildFailureFixtures } from "./failure-fixtures.mjs";
//   또는 CLI: node apps/conversion/scripts/failure-fixtures.mjs [outDir]  (파일로 덤프)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/** spike-samples 에서 정상 실HWP 1건을 고른다(암호화 플래그 조작의 원본). */
export function pickRealHwp() {
  const candidates = [
    "spike-samples/files/13_4410dd3ad481bce0-지원신청서_및_사업계획서_양식_.hwp",
    "spike-samples/files/16_83f4ed2267003f9f-2._양식_지원신청서_및_사업계획서.hwp",
    "spike-samples/files/12_e9de9609bf6b0d64-붙임2.Stand-up맞춤지원신청서및계획서서식.hwp",
  ];
  for (const rel of candidates) {
    const p = join(REPO_ROOT, rel);
    if (existsSync(p)) return { path: p, body: Buffer.from(readFileSync(p)) };
  }
  throw new Error("spike-samples 에서 실HWP 를 찾지 못했습니다. (픽스처 합성 원본 필요)");
}

/** spike-samples 에서 정상 실HWPX 1건을 고른다. */
export function pickRealHwpx() {
  const candidates = [
    "spike-samples/files/01_6531c283efa40421-융자신청서_사업계획서_및_개인정보수집동의서_.hwpx",
    "spike-samples/files/03_94b98bf44e7556e4-2026년_시중은행_협력자금_대출신청서_및_사업계획서.hwpx",
  ];
  for (const rel of candidates) {
    const p = join(REPO_ROOT, rel);
    if (existsSync(p)) return { path: p, body: Buffer.from(readFileSync(p)) };
  }
  return null;
}

/**
 * 암호화 HWP 합성.
 * 방법: 정상 HWP 의 CFB 안 "HWP Document File" FileHeader 스트림에서 속성 플래그
 * (signature+32+4 오프셋의 UInt32LE) 에 암호화 비트(0x02) 를 켠다.
 * → checkIntegrity 가 isHwpEncrypted=true 로 즉시 failed(encrypted_source).
 *    (플래그를 못 읽어 통과해도 soffice 가 복호화 실패로 PDF 미생성 → 여전히 failed.)
 */
export function synthEncryptedHwp() {
  const { body } = pickRealHwp();
  const buf = Buffer.from(body); // copy
  const sig = Buffer.from("HWP Document File", "ascii");
  const idx = buf.indexOf(sig);
  if (idx < 0) throw new Error("FileHeader signature 를 찾지 못했습니다.");
  const propOffset = idx + 32 + 4;
  const before = buf.readUInt32LE(propOffset);
  buf.writeUInt32LE(before | 0x02, propOffset);
  return buf;
}

/**
 * 암호화 HWPX 합성.
 * 방법: HWPX 는 ZIP(PKZIP). 로컬 파일 헤더의 general purpose bit flag(offset 6, UInt16LE)
 * 에 암호화 비트(0x0001) 를 켠다 → isHwpxEncrypted=true → failed(encrypted_source).
 */
export function synthEncryptedHwpx() {
  const real = pickRealHwpx();
  if (!real) return null;
  const buf = Buffer.from(real.body);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("ZIP local header signature 아님");
  const flags = buf.readUInt16LE(6);
  buf.writeUInt16LE(flags | 0x0001, 6);
  return buf;
}

/**
 * 암호화 PDF 합성.
 * 방법: 최소 유효 PDF 에 /Encrypt 를 참조하는 trailer 를 넣는다
 * → isPdfEncrypted=true(=/Encrypt 포함) → failed(encrypted_source).
 */
export function synthEncryptedPdf() {
  const parts = [];
  const offs = [];
  const add = (s) => { offs.push(parts.join("").length); parts.push(s); };
  parts.push("%PDF-1.4\n");
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  add("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n");
  add("4 0 obj\n<< /Filter /Standard /V 2 /R 3 /O (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /U (yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy) /P -44 >>\nendobj\n");
  const xrefStart = parts.join("").length;
  let xref = "xref\n0 5\n0000000000 65535 f \n";
  for (const o of offs) xref += String(o).padStart(10, "0") + " 00000 n \n";
  parts.push(xref);
  parts.push(`trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.from(parts.join(""));
}

/**
 * 손상 HWP 합성 (렌더 실패로 failed).
 * 방법: 정상 HWP 의 CFB 매직(D0 CF 11 E0...) 은 유지해 포맷 판정은 hwp 로 되게 하되,
 * FileHeader 이후 바디를 난수로 덮어 soffice 가 PDF 를 못 만들게 한다
 * → 무결성은 통과(암호화 아님) → renderPdf 실패 → failed(pdf render failed).
 */
export function synthCorruptHwp() {
  const { body } = pickRealHwp();
  const buf = Buffer.from(body);
  // 앞 6KB(CFB 헤더 + FileHeader 스트림 영역)는 남기고 이후를 0xFF 로 덮는다.
  const keep = Math.min(6 * 1024, buf.length);
  for (let i = keep; i < buf.length; i += 1) buf[i] = 0xff;
  return buf;
}

/**
 * 지원하지 않는 포맷 (unsupported_format 로 failed).
 * 방법: 확장자를 .txt 등 미지원으로 준다(내용 무관). detectFormat=null.
 */
export function synthUnsupported() {
  return Buffer.from("이 파일은 변환 대상 포맷이 아닙니다.\n", "utf8");
}

/**
 * 이미지 전용(텍스트 0) PDF 합성 — 부분 성공(partial) 재현.
 * 방법: 텍스트 오퍼레이터 없이 사각형만 그리는 유효 1p PDF.
 * → PDF 채택 성공 + pdftoppm 페이지 이미지 성공 + pdftotext 결과 공백 → markdown 실패
 * → jobStatus=partial, warning=text_extraction_failed.
 */
export function synthTextlessPdf() {
  const content = "q 0 0 1 rg 50 50 500 700 re f Q\n"; // 파란 사각형만, 텍스트 없음
  const parts = [];
  const offs = [];
  const add = (s) => { offs.push(parts.join("").length); parts.push(s); };
  parts.push("%PDF-1.4\n");
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  add("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>\nendobj\n");
  add(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  const xrefStart = parts.join("").length;
  let xref = "xref\n0 5\n0000000000 65535 f \n";
  for (const o of offs) xref += String(o).padStart(10, "0") + " 00000 n \n";
  parts.push(xref);
  parts.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.from(parts.join(""));
}

/**
 * 다중 페이지(3p) 텍스트 PDF 합성 — page image 상한(partial page image) 재현용.
 * 방법: 3개의 페이지에 각각 텍스트 스트림. maxPages=1 로 변환하면 page_image_partial.
 */
export function synthMultiPagePdf() {
  const mkContent = (label) =>
    `BT /F1 24 Tf 72 760 Td (${label}) Tj ET\n`;
  const parts = [];
  const offs = [];
  const add = (s) => { offs.push(parts.join("").length); parts.push(s); };
  parts.push("%PDF-1.4\n");
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>\nendobj\n");
  const fontRes = "<< /Font << /F1 9 0 R >> >>";
  add(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources ${fontRes} >>\nendobj\n`);
  const c1 = mkContent("Page one content line for coverage test");
  add(`4 0 obj\n<< /Length ${c1.length} >>\nstream\n${c1}endstream\nendobj\n`);
  add(`5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources ${fontRes} >>\nendobj\n`);
  const c2 = mkContent("Page two content line for coverage test");
  add(`6 0 obj\n<< /Length ${c2.length} >>\nstream\n${c2}endstream\nendobj\n`);
  add(`7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 8 0 R /Resources ${fontRes} >>\nendobj\n`);
  const c3 = mkContent("Page three content line for coverage test");
  add(`8 0 obj\n<< /Length ${c3.length} >>\nstream\n${c3}endstream\nendobj\n`);
  add("9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  const xrefStart = parts.join("").length;
  let xref = "xref\n0 10\n0000000000 65535 f \n";
  for (const o of offs) xref += String(o).padStart(10, "0") + " 00000 n \n";
  parts.push(xref);
  parts.push(`trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.from(parts.join(""));
}

/** 모든 픽스처를 메모리 버퍼로 반환. */
export function buildFailureFixtures() {
  return {
    encryptedHwp: { filename: "encrypted.hwp", body: synthEncryptedHwp() },
    encryptedHwpx: (() => {
      const b = synthEncryptedHwpx();
      return b ? { filename: "encrypted.hwpx", body: b } : null;
    })(),
    encryptedPdf: { filename: "encrypted.pdf", body: synthEncryptedPdf() },
    corruptHwp: { filename: "corrupt.hwp", body: synthCorruptHwp() },
    unsupported: { filename: "note.txt", body: synthUnsupported() },
    textlessPdf: { filename: "imageonly.pdf", body: synthTextlessPdf() },
    multiPagePdf: { filename: "multipage.pdf", body: synthMultiPagePdf() },
    realHwp: (() => {
      const r = pickRealHwp();
      return { filename: "real.hwp", body: r.body };
    })(),
  };
}

// CLI: 파일로 덤프 (선택). 샌드박스에서는 삭제 불가하므로 새 디렉토리에만 쓴다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ?? "/tmp/t9-fixtures";
  mkdirSync(outDir, { recursive: true });
  const fx = buildFailureFixtures();
  for (const [name, f] of Object.entries(fx)) {
    if (!f) { console.log(`  (skip) ${name}: 원본 없음`); continue; }
    const p = join(outDir, f.filename);
    writeFileSync(p, f.body);
    console.log(`  wrote ${name} -> ${p} (${f.body.length} bytes)`);
  }
}

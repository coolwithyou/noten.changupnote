#!/usr/bin/env node
// T9 (변환 코어 단위) — 계획 11장 실패 경로 통합 테스트.
// convertDocument 를 직접 돌려(네트워크·R2·DB 없이) 각 실패 유형이 명세대로 판정되는지 검증한다.
// 전 구간(API→큐→변환→R2/DB) 테스트는 verify-failure-api.mjs / verify-failure-e2e.mjs 참고.
//
// 사용법: node apps/conversion/scripts/failure-path-test.mjs
// 전제: soffice(+H2Orestart) / pdftoppm / pdftotext / pdfinfo / unzip 설치.
//
// 커버(계획 11장):
//   - 암호화 HWP / HWPX / PDF  → failed + encrypted_source
//   - 손상 HWP(렌더 실패)       → failed (pdf render failed)
//   - 타임아웃(soffice hang)     → failed (soffice timeout, 주입된 짧은 타임아웃)
//   - 대용량(maxBytes 초과)      → failed + oversize_source
//   - sha256 불일치              → failed + sha256_mismatch
//   - 미지원 포맷                → failed + unsupported_format
//   - 부분성공(텍스트 추출 실패) → partial + text_extraction_failed (PDF·이미지는 유지)
//   - page image 상한 초과       → page_image_partial warning (maxPages 주입)

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDocument } from "./convert-lib.mjs";
import { buildFailureFixtures } from "./failure-fixtures.mjs";

// 주의: 이 샌드박스의 H2Orestart 는 shared(--shared) 가 아니라 기본 유저 프로필에 설치돼 있다
// (`unopkg list` 에는 보이나 `unopkg list --shared` 에는 없음). 따라서 워커별 프로필 격리
// (CONVERSION_LO_SHARED_H2O=1) 를 켜면 격리 프로필에 H2O 가 없어 HWP 로드가 실패한다.
// 프로덕션 컨테이너는 H2O 를 --shared 로 깔아 격리를 켠다(Dockerfile). 로컬/샌드박스 검증은
// 기본 프로필(H2O 존재) 을 쓰므로 이 변수를 켜지 않는다. 명시적으로 끈다.
delete process.env.CONVERSION_LO_SHARED_H2O;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err?.message ?? err}`);
  }
}

function work(tag) {
  return mkdtempSync(join(tmpdir(), `t9-${tag}.`));
}
function run(fixture, extra = {}) {
  return convertDocument(
    {
      body: fixture.body,
      filename: fixture.filename,
      expectedSha256: extra.expectedSha256 ?? null,
      workDir: work(fixture.filename.replace(/\W+/g, "")),
      ...extra,
    },
    {},
  );
}

console.log("T9 실패 경로 통합 테스트 (변환 코어)\n");

const fx = buildFailureFixtures();

// --- 암호화 HWP → failed + encrypted_source ---
check("암호화 HWP → failed + encrypted_source", () => {
  const r = run(fx.encryptedHwp);
  assert.equal(r.jobStatus, "failed");
  assert.equal(r.error, "encrypted_source");
  assert.ok(r.quality.warnings.includes("encrypted_source"));
  assert.equal(r.quality.status, "failed");
  assert.equal(r.pdf, null);
  assert.deepEqual(r.pageImages, []);
  assert.equal(r.markdown, null);
});

// --- 암호화 HWPX → failed + encrypted_source (원본 있을 때만) ---
if (fx.encryptedHwpx) {
  check("암호화 HWPX → failed + encrypted_source", () => {
    const r = run(fx.encryptedHwpx);
    assert.equal(r.jobStatus, "failed");
    assert.equal(r.error, "encrypted_source");
    assert.ok(r.quality.warnings.includes("encrypted_source"));
  });
} else {
  console.log("  - 암호화 HWPX: spike-samples 에 HWPX 원본 없음 → 스킵");
}

// --- 암호화 PDF → failed + encrypted_source ---
check("암호화 PDF(/Encrypt) → failed + encrypted_source", () => {
  const r = run(fx.encryptedPdf);
  assert.equal(r.jobStatus, "failed");
  assert.equal(r.error, "encrypted_source");
  assert.ok(r.quality.warnings.includes("encrypted_source"));
});

// --- 손상 HWP(렌더 실패) → failed ---
check("손상 HWP → failed (pdf render 실패)", () => {
  const r = run(fx.corruptHwp);
  assert.equal(r.jobStatus, "failed");
  // 무결성은 통과(암호화 아님)하고 renderPdf 단계에서 실패해야 한다.
  assert.ok(!r.quality.warnings.includes("encrypted_source"));
  assert.equal(r.pdf, null);
  assert.equal(r.quality.status, "failed");
  assert.ok(typeof r.error === "string" && r.error.length > 0);
});

// --- 타임아웃(soffice hang) → failed. 실제 수분 대기 대신 1ms 타임아웃 주입. ---
check("타임아웃 주입(sofficeTimeoutMs=1) → failed + soffice timeout", () => {
  const r = run(fx.realHwp, { sofficeTimeoutMs: 1 });
  assert.equal(r.jobStatus, "failed");
  assert.equal(r.pdf, null);
  assert.equal(r.quality.status, "failed");
  assert.match(r.error, /timeout/i);
});

// --- 대용량(maxBytes 초과) → failed + oversize_source ---
check("대용량(maxBytes 주입) → failed + oversize_source", () => {
  // 실HWP 를 아주 작은 상한으로 넘겨 oversize 로 판정 (실제 50MB 파일 생성 회피).
  const r = run(fx.realHwp, { maxBytes: 1024 });
  assert.equal(r.jobStatus, "failed");
  assert.equal(r.error, "oversize_source");
  assert.ok(r.quality.warnings.includes("oversize_source"));
  assert.equal(r.pdf, null);
});

// --- sha256 불일치 → failed + sha256_mismatch ---
check("sha256 불일치 → failed + sha256_mismatch", () => {
  const r = run(fx.realHwp, { expectedSha256: "0".repeat(64) });
  assert.equal(r.jobStatus, "failed");
  assert.equal(r.error, "sha256_mismatch");
  assert.ok(r.quality.warnings.includes("sha256_mismatch"));
});

// --- 미지원 포맷 → failed + unsupported_format ---
check("미지원 포맷(.txt) → failed + unsupported_format", () => {
  const r = run(fx.unsupported);
  assert.equal(r.jobStatus, "failed");
  assert.equal(r.error, "unsupported_format");
  assert.ok(r.quality.warnings.includes("unsupported_format"));
  assert.equal(r.format, null);
});

// --- 부분성공: PDF·이미지 성공 + 텍스트 추출 실패 → partial ---
check("부분성공(텍스트 추출 실패) → partial, PDF·이미지 유지", () => {
  const r = run(fx.textlessPdf);
  assert.equal(r.jobStatus, "partial");
  assert.ok(r.pdf, "PDF artifact 는 남아야 한다");
  assert.ok(r.pageImages.length > 0, "page image 는 남아야 한다");
  assert.equal(r.markdown, null, "markdown 은 추출 실패로 없어야 한다");
  assert.ok(r.quality.warnings.includes("text_extraction_failed"));
  // pdfRendered=true, textExtracted=false → manual_required
  assert.equal(r.quality.status, "manual_required");
  assert.equal(r.quality.textCoverage, 0);
});

// --- page image 상한 초과 → page_image_partial warning ---
check("page image 상한(maxPages=1) 초과 → page_image_partial warning", () => {
  const r = run(fx.multiPagePdf, { maxPages: 1 });
  assert.ok(r.pdf, "PDF 는 성공");
  assert.equal(r.pdf.pageCount, 3, "전체 3페이지로 집계");
  assert.equal(r.pageImages.length, 1, "앞 1페이지만 이미지화");
  assert.ok(r.quality.warnings.includes("page_image_partial"));
  // page_image_partial 은 심각 warning → usable_with_review 이상으로 강등
  assert.notEqual(r.quality.status, "usable");
});

// --- 정상 대조군: 실HWP 는 succeeded/partial 이어야 (실패 경로 판정이 정상까지 잡아먹지 않음) ---
check("정상 대조군: 실HWP → 실패 아님(succeeded|partial)", () => {
  const r = run(fx.realHwp);
  assert.ok(["succeeded", "partial"].includes(r.jobStatus), `기대 succeeded|partial, 실제 ${r.jobStatus} (${r.error ?? ""})`);
  assert.ok(r.pdf, "PDF 렌더 성공");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} / 실패 ${failed}`);
process.exit(failed === 0 ? 0 : 1);

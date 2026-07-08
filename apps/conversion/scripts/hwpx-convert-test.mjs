#!/usr/bin/env node
// hwp2hwpx 트랙 Phase 1 검증: .hwp 바이너리 → hwpx 변환 + STORE 재포장 정규화 + 업로드 경로.
//
// 단정:
//  1) 변환 성공(outcome="converted") — spike-samples/files/*.hwp 표본 2~3건
//  2) 산출 hwpx 가 PK(zip) 시그니처로 시작
//  3) 첫 로컬 엔트리가 "mimetype" 이며 STORE(method 0) — OWPML 표준 정규화 확인
//  4) 재포장본이 readHwpxEntries 로 well-formed 파싱, mimetype 내용 = application/hwp+zip
//  5) 매직 바이트 게이팅: PK 입력 → skipped_already_hwpx, 비 hwp → skipped_not_hwp_binary
//  6) 업로드 경로: uploadArtifacts 가 kind="hwpx"(.hwpx 키, application/hwp+zip) artifact 포함
//
// 사용법: node apps/conversion/scripts/hwpx-convert-test.mjs [jar경로]
//   jar 미지정 시 env HWP2HWPX_JAR → spike-out/hwp2hwpx/hwp2hwpx-cli.jar 순.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { makeHwpxConvert } from "./hwpx-convert-lib.mjs";
import { readHwpxEntries } from "../../../packages/core/dist/documents/hwpx-fill.js";
import { uploadArtifacts } from "./convert-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

const jarPath =
  process.argv[2] ??
  process.env.HWP2HWPX_JAR ??
  join(ROOT, "spike-out/hwp2hwpx/hwp2hwpx-cli.jar");

if (!existsSync(jarPath)) {
  console.error(`✗ jar 없음: ${jarPath}`);
  console.error("  Phase 0 재현: bash scripts/spike/hwp2hwpx/build-jar.sh");
  process.exit(1);
}
console.log(`jar: ${jarPath}\n`);

const convert = makeHwpxConvert({ jarPath });

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 첫 로컬 엔트리(offset 0)가 name·method 인지 파싱. */
function firstLocalEntry(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "첫 로컬 헤더 시그니처(PK\\x03\\x04) 불일치");
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const name = buf.subarray(30, 30 + nameLen).toString("utf8");
  return { name, method };
}

// --- 1~4: 표본 변환 + 정규화 단정 ---
const sampleDir = join(ROOT, "spike-samples/files");
const samples = readdirSync(sampleDir)
  .filter((f) => f.toLowerCase().endsWith(".hwp"))
  .sort()
  .slice(0, 3);
assert.ok(samples.length >= 2, `표본 부족: ${samples.length}건`);

for (const file of samples) {
  const body = readFileSync(join(sampleDir, file));
  const workDir = mkdtempSync(join(tmpdir(), "hwpx-convert-test."));
  const res = convert({ body, workDir });
  const short = file.slice(0, 34);

  check(`${short} → converted`, () => {
    assert.equal(res.outcome, "converted", `outcome=${res.outcome} reason=${res.reason}`);
    assert.ok(res.artifact && res.artifact.bytes > 0, "artifact 비어있음");
  });

  const out = readFileSync(res.artifact.path);
  check(`${short} → PK 시그니처`, () => {
    assert.equal(out.subarray(0, 2).toString("latin1"), "PK");
  });
  check(`${short} → mimetype STORE 첫 엔트리`, () => {
    const first = firstLocalEntry(out);
    assert.equal(first.name, "mimetype", `첫 엔트리=${first.name}`);
    assert.equal(first.method, 0, `mimetype method=${first.method} (0=STORE 기대)`);
  });
  check(`${short} → well-formed + mimetype 내용`, () => {
    const entries = readHwpxEntries(out);
    const mt = entries.find((e) => e.name === "mimetype");
    assert.ok(mt, "mimetype 엔트리 부재");
    assert.equal(mt.data.toString("utf8").trim(), "application/hwp+zip");
    // OWPML 핵심 파트 존재 (Contents/section0.xml 등)
    assert.ok(entries.some((e) => /section0\.xml$/i.test(e.name)), "section0.xml 부재");
  });
}

// --- 5: 매직 바이트 게이팅 ---
check("PK 입력 → skipped_already_hwpx", () => {
  const pk = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const r = convert({ body: pk, workDir: mkdtempSync(join(tmpdir(), "hwpx-gate.")) });
  assert.equal(r.outcome, "skipped_already_hwpx");
  assert.equal(r.artifact, null);
});
check("비 hwp 입력 → skipped_not_hwp_binary", () => {
  const junk = Buffer.from("%PDF-1.7 not a hwp", "ascii");
  const r = convert({ body: junk, workDir: mkdtempSync(join(tmpdir(), "hwpx-gate.")) });
  assert.equal(r.outcome, "skipped_not_hwp_binary");
  assert.equal(r.artifact, null);
});

// --- 6: 업로드 경로 (stub storage) — hwpx artifact 가 목록에 포함 ---
await (async () => {
  const body = readFileSync(join(sampleDir, samples[0]));
  const workDir = mkdtempSync(join(tmpdir(), "hwpx-upload."));
  const res = convert({ body, workDir });
  assert.equal(res.outcome, "converted");

  const puts = [];
  const stubStorage = {
    async putObject({ key, body: b, contentType }) {
      puts.push({ key, contentType, bytes: b.length });
      return { key, url: `stub://${key}` };
    },
    async getObjectText() { return ""; },
    publicUrl(key) { return `stub://${key}`; },
  };

  const result = {
    sha256: "a".repeat(64),
    converterVersion: "conv-test",
    pdf: null, pageImages: [], markdown: null,
    hwpx: res.artifact,
    hwpxConversion: res,
  };
  const artifacts = await uploadArtifacts({
    storage: stubStorage, result,
    source: "bizinfo", sourceId: "PBLN.TEST", filename: samples[0],
    sourceSha256: result.sha256, keyPrefix: "conversion-dev",
  });

  check("uploadArtifacts → hwpx artifact 포함", () => {
    const hwpxArt = artifacts.find((a) => a.kind === "hwpx");
    assert.ok(hwpxArt, "hwpx artifact 부재");
    assert.match(hwpxArt.storageKey, /\/hwpx\/[^/]+\.hwpx$/, `키 형식: ${hwpxArt.storageKey}`);
    assert.equal(hwpxArt.contentType, "application/hwp+zip");
    assert.equal(hwpxArt.metadata.converter, "hwp2hwpx");
    assert.equal(hwpxArt.metadata.outcome, "converted");
    assert.ok(puts.some((p) => p.key === hwpxArt.storageKey), "putObject 미호출");
  });
})();

console.log(`\n✅ 전체 ${passed}개 통과 (표본 ${samples.length}건)`);

// HWPX 채움 라운드트립 스파이크 — docs/plans/2026-07-07-hwpx-fill-export.md Phase 0.
//
// 검증 항목 (샘플 hwpx 전수):
//   1. zero-dep zip 읽기(central directory + inflateRaw) → 쓰기(mimetype Stored 첫 엔트리)
//   2. Contents/section*.xml 의 빈 텍스트 노드(<hp:t/>)에 테스트 값 스플라이스 삽입
//   3. 무결성: 비수정 엔트리 바이트 동일 · 삽입 역치환 시 원본 복원 · XML well-formed
//   4. 채움본을 spike-out/hwpx-fill/ 에 기록 (후속: Docker 변환 서버 렌더 검증 입력)
//
// 실행: node scripts/spike/hwpx-fill-roundtrip.mjs [샘플 디렉토리...]
//   기본: spike-samples/files spike-samples2/files

import { inflateRawSync, deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";

// ---------- zip 읽기 ----------

/** @returns {Array<{name:string, data:Buffer, method:number}>} central directory 순서 */
function readZip(buf) {
  // EOCD(0x06054b50)를 뒤에서 탐색 (comment 최대 64KB)
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found (zip 아님?)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`central header 손상 @${off}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");

    // local header 를 지나 데이터 위치 계산 (local 의 name/extra 길이는 central 과 다를 수 있음)
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(raw)
      : method === 8 ? inflateRawSync(raw)
      : (() => { throw new Error(`미지원 압축 방식 ${method}: ${name}`); })();

    if (!name.endsWith("/")) entries.push({ name, data, method });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- zip 쓰기 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** mimetype 은 Stored·첫 엔트리, 나머지 Deflate. 디렉토리 엔트리 없음, UTF-8 플래그. */
function writeZip(entries) {
  const ordered = [
    ...entries.filter((e) => e.name === "mimetype"),
    ...entries.filter((e) => e.name !== "mimetype"),
  ];
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of ordered) {
    const name = Buffer.from(entry.name, "utf8");
    const stored = entry.name === "mimetype";
    const body = stored ? entry.data : deflateRawSync(entry.data, { level: 9 });
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 30); // extra/comment len
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(ordered.length, 8);
  eocd.writeUInt16LE(ordered.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---------- 채움 ----------

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 이스케이프 경로를 실제로 태우기 위해 &·< 포함 값을 섞는다.
// HWPX_FILL_VALUES(콤마 구분)·HWPX_FILL_MAX 로 재정의 가능 — 리플로우 격리 실험용.
const TEST_VALUES = process.env.HWPX_FILL_VALUES
  ? process.env.HWPX_FILL_VALUES.split(",")
  : [
      "주식회사 채움검증",
      "테스트 & 검증 <스파이크>",
      "123-45-67890",
      "서울특별시 강남구",
      "2026-07-07",
    ];
const FILL_MAX = process.env.HWPX_FILL_MAX
  ? Number(process.env.HWPX_FILL_MAX)
  : TEST_VALUES.length;

/** 빈 텍스트 노드 <hp:t/> 최대 max개를 테스트 값으로 치환. @returns {filled, xml, fills[]} */
function fillEmptyTextNodes(xml, max = FILL_MAX) {
  const fills = [];
  let out = "";
  let cursor = 0;
  let i = 0;
  while (fills.length < max) {
    const at = xml.indexOf("<hp:t/>", cursor);
    if (at < 0) break;
    const value = TEST_VALUES[i % TEST_VALUES.length];
    const replacement = `<hp:t>${escapeXml(value)}</hp:t>`;
    out += xml.slice(cursor, at) + replacement;
    cursor = at + "<hp:t/>".length;
    fills.push({ at, value, replacement });
    i++;
  }
  out += xml.slice(cursor);
  return { filled: fills.length, xml: out, fills };
}

// ---------- 검증 ----------

function xmllintOk(xmlBuf) {
  const r = spawnSync("xmllint", ["--noout", "-"], { input: xmlBuf, encoding: "buffer" });
  if (r.error) return null; // xmllint 미설치
  return r.status === 0;
}

function verify(original, rebuiltBuf, fillsBySection) {
  const problems = [];
  const rebuilt = readZip(rebuiltBuf); // 자기 산출물 재파싱

  if (rebuiltBuf.readUInt32LE(0) !== 0x04034b50) problems.push("첫 시그니처 손상");
  const firstNameLen = rebuiltBuf.readUInt16LE(26);
  const firstName = rebuiltBuf.subarray(30, 30 + firstNameLen).toString("utf8");
  if (firstName !== "mimetype") problems.push(`첫 엔트리가 mimetype 아님: ${firstName}`);
  if (rebuiltBuf.readUInt16LE(8) !== 0) problems.push("mimetype 이 Stored 아님");

  const origByName = new Map(original.map((e) => [e.name, e.data]));
  for (const entry of rebuilt) {
    const orig = origByName.get(entry.name);
    if (!orig) { problems.push(`원본에 없는 엔트리: ${entry.name}`); continue; }
    const fills = fillsBySection.get(entry.name);
    if (!fills) {
      if (!orig.equals(entry.data)) problems.push(`비수정 엔트리 바이트 불일치: ${entry.name}`);
    } else {
      // 삽입 역치환 시 원본과 정확히 일치해야 한다 (스플라이스 무손실 증명)
      let restored = entry.data.toString("utf8");
      for (const f of fills) restored = restored.replace(f.replacement, "<hp:t/>");
      if (restored !== orig.toString("utf8")) problems.push(`역치환 복원 실패: ${entry.name}`);
      const lint = xmllintOk(entry.data);
      if (lint === false) problems.push(`XML not well-formed: ${entry.name}`);
    }
  }
  if (rebuilt.length !== original.length) {
    problems.push(`엔트리 수 불일치: ${original.length} → ${rebuilt.length}`);
  }
  return problems;
}

// ---------- 메인 ----------

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["spike-samples/files", "spike-samples2/files"];
const outDir = process.env.HWPX_FILL_OUT || "spike-out/hwpx-fill";
mkdirSync(outDir, { recursive: true });

const results = [];
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".hwpx")).sort()) {
    const path = join(dir, file);
    const row = { file, filled: 0, problems: [], out: null, skipped: false };
    try {
      const buf = readFileSync(path);
      // 형식 판별은 확장자가 아니라 매직 바이트: PK(zip)=hwpx, D0CF11E0(CFBF)=hwp 바이너리 위장
      if (buf.readUInt32LE(0) === 0xe011cfd0) {
        row.skipped = true;
        row.problems.push("SKIP: .hwpx 확장자지만 실체는 HWP 5.x 바이너리(CFBF) — hwp 트랙 소관");
        results.push(row);
        continue;
      }
      const entries = readZip(buf);
      const fillsBySection = new Map();
      let totalFilled = 0;

      const rebuiltEntries = entries.map((entry) => {
        if (!/^Contents\/section\d+\.xml$/.test(entry.name)) return entry;
        const { filled, xml, fills } = fillEmptyTextNodes(entry.data.toString("utf8"));
        if (filled === 0) return entry;
        totalFilled += filled;
        fillsBySection.set(entry.name, fills);
        return { ...entry, data: Buffer.from(xml, "utf8") };
      });

      row.filled = totalFilled;
      if (totalFilled === 0) {
        row.problems.push("빈 텍스트 노드 없음 (채움 미수행 — 원본 그대로 재압축만 검증)");
      }
      const rebuilt = writeZip(rebuiltEntries);
      row.problems.push(...verify(entries, rebuilt, fillsBySection));

      const outPath = join(outDir, file.replace(/\.hwpx$/i, ".filled.hwpx"));
      writeFileSync(outPath, rebuilt);
      row.out = outPath;
    } catch (err) {
      row.problems.push(`예외: ${err.message}`);
    }
    results.push(row);
  }
}

// 리포트
let pass = 0;
let skip = 0;
for (const r of results) {
  const hard = r.problems.filter(
    (p) => !p.startsWith("빈 텍스트 노드 없음") && !p.startsWith("SKIP:"),
  );
  const ok = !r.skipped && hard.length === 0;
  if (ok) pass++;
  if (r.skipped) skip++;
  const label = r.skipped ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${label}  채움 ${String(r.filled).padStart(2)}  ${r.file}`);
  for (const p of r.problems) console.log(`      - ${p}`);
}
const target = results.length - skip;
console.log(`\n합계: ${pass}/${target} PASS (SKIP ${skip} — hwp 바이너리 위장)`);
writeFileSync(join(outDir, "report.json"), JSON.stringify(results, null, 2));
console.log(`채움본·리포트: ${outDir}/`);
process.exit(pass === target ? 0 : 1);

/**
 * hwpx-fill.ts 단위 테스트 (node:assert/strict, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/documents/hwpx-fill.test.ts
 *
 * 실 샘플 파일 의존 없음 — 합성 픽스처(최소 section XML + writeHwpx 로 만든 인메모리 hwpx)로 검증.
 * 커버: 매직 바이트 판별 / zip 라운드트립 / 셀 스캔 / 라벨 매칭 / 스플라이스 채움 / 오케스트레이터.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  detectHwpFormat,
  readHwpxEntries,
  writeHwpx,
  scanTableCells,
  matchLabelCells,
  fillCells,
  fillHwpxTemplate,
  type HwpxEntry,
  type HwpxTableCell,
} from "./hwpx-fill.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------
// 픽스처 빌더 (최소 OWPML 조각)
// ---------------------------------------------------------------------

function runText(text: string): string {
  return `<hp:run charPrIDRef="1"><hp:t>${text}</hp:t></hp:run>`;
}
const RUN_EMPTY_T = `<hp:run charPrIDRef="1"><hp:t/></hp:run>`;
const RUN_SELF_CLOSE = `<hp:run charPrIDRef="7"/>`;
const RUN_OPEN_CLOSE = `<hp:run charPrIDRef="1"></hp:run>`; // hp:t 없음·self-close 아님 → unfillable

function tc(opts: {
  col: number;
  row: number;
  colSpan?: number;
  rowSpan?: number;
  inner: string;
}): string {
  const { col, row, colSpan = 1, rowSpan = 1, inner } = opts;
  return (
    `<hp:tc name="" borderFillIDRef="1">` +
    `<hp:subList vertAlign="CENTER"><hp:p id="0" paraPrIDRef="0" styleIDRef="0">${inner}` +
    `<hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/>` +
    `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
    `<hp:cellSz width="1000" height="500"/>` +
    `<hp:cellMargin left="0" right="0" top="0" bottom="0"/>` +
    `</hp:tc>`
  );
}

function tr(cells: string): string {
  return `<hp:tr>${cells}</hp:tr>`;
}

function tbl(rows: string): string {
  return (
    `<hp:run charPrIDRef="1"><hp:tbl rowCnt="9" colCnt="9" borderFillIDRef="1">` +
    `<hp:sz width="2000" height="1000"/><hp:pos treatAsChar="1"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
    `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    `${rows}</hp:tbl></hp:run>`
  );
}

function section(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
    `<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ` +
    `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">` +
    `<hp:p id="1" paraPrIDRef="0" styleIDRef="0">${body}</hp:p>` +
    `</hs:sec>`
  );
}

// 신청기업 정보 표: 우측 인접 채움(hp:t/ · self-close run 두 경로) + 콜론 라벨.
function infoTable(): string {
  return tbl(
    tr(
      tc({ col: 0, row: 0, inner: runText("기업명 (필수)") }) +
        tc({ col: 1, row: 0, colSpan: 3, inner: RUN_EMPTY_T }),
    ) +
      tr(
        tc({ col: 0, row: 1, inner: runText("사업자등록번호") }) +
          tc({ col: 1, row: 1, colSpan: 3, inner: RUN_SELF_CLOSE }),
      ) +
      tr(
        tc({ col: 0, row: 2, inner: runText("이메일:") }) +
          tc({ col: 1, row: 2, colSpan: 3, inner: RUN_EMPTY_T }),
      ),
  );
}

// ---------------------------------------------------------------------
console.log("hwpx-fill 단위 테스트\n");

// === 1. detectHwpFormat: PK / CFBF / 기타 ===
check("detectHwpFormat: PK → hwpx, CFBF → hwp-binary, 그 외 → unknown", () => {
  assert.equal(detectHwpFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04])), "hwpx");
  assert.equal(detectHwpFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])), "hwp-binary");
  assert.equal(detectHwpFormat(Buffer.from([0x25, 0x50, 0x44, 0x46])), "unknown"); // %PDF
  assert.equal(detectHwpFormat(Buffer.from([0x50, 0x4b])), "unknown"); // 4바이트 미만
});

// === 2. zip 라운드트립 ===
check("writeHwpx→readHwpxEntries: 복원 + mimetype 첫 엔트리·Stored", () => {
  const entries: HwpxEntry[] = [
    { name: "mimetype", data: Buffer.from("application/hwp+zip", "utf8"), method: 0 },
    { name: "version.xml", data: Buffer.from("<hv:HCFVersion/>", "utf8"), method: 8 },
    { name: "Contents/section0.xml", data: Buffer.from(section(""), "utf8"), method: 8 },
  ];
  const buf = writeHwpx(entries);

  // 첫 로컬 시그니처 + 첫 엔트리 = mimetype + Stored.
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(8), 0, "mimetype 은 Stored(method 0)");
  const firstNameLen = buf.readUInt16LE(26);
  assert.equal(buf.subarray(30, 30 + firstNameLen).toString("utf8"), "mimetype");
  assert.equal(detectHwpFormat(buf), "hwpx");

  const restored = readHwpxEntries(buf);
  assert.equal(restored.length, 3);
  assert.equal(restored[0]!.name, "mimetype");
  for (const orig of entries) {
    const got = restored.find((e) => e.name === orig.name)!;
    assert.ok(got, `엔트리 복원: ${orig.name}`);
    assert.ok(got.data.equals(orig.data), `바이트 동일: ${orig.name}`);
  }
});

// === 3. scanTableCells: 좌표·텍스트·빈 셀·span ===
check("scanTableCells: 좌표/텍스트/빈 셀/colSpan·rowSpan", () => {
  const xml = section(
    tbl(
      tr(
        tc({ col: 0, row: 0, colSpan: 2, rowSpan: 3, inner: runText("제출서류") }) +
          tc({ col: 2, row: 0, inner: RUN_EMPTY_T }),
      ),
    ),
  );
  const cells = scanTableCells(xml);
  assert.equal(cells.length, 2);

  const label = cells.find((c) => c.text === "제출서류")!;
  assert.equal(label.colAddr, 0);
  assert.equal(label.rowAddr, 0);
  assert.equal(label.colSpan, 2);
  assert.equal(label.rowSpan, 3);
  assert.equal(label.isEmpty, false);
  assert.equal(label.tableIndex, 0);
  // 오프셋이 실제 <hp:tc … </hp:tc> 범위를 가리킨다.
  assert.ok(xml.slice(label.startOffset, label.endOffset).startsWith("<hp:tc"));
  assert.ok(xml.slice(label.startOffset, label.endOffset).endsWith("</hp:tc>"));

  const empty = cells.find((c) => c.colAddr === 2)!;
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.text, "");
  assert.equal(empty.colSpan, 1);
});

check("scanTableCells: 다중 표는 tableIndex 로 분리", () => {
  const xml = section(
    tbl(tr(tc({ col: 0, row: 0, inner: runText("A") }))) +
      tbl(tr(tc({ col: 0, row: 0, inner: runText("B") }))),
  );
  const cells = scanTableCells(xml);
  assert.equal(cells.length, 2);
  assert.equal(cells.find((c) => c.text === "A")!.tableIndex, 0);
  assert.equal(cells.find((c) => c.text === "B")!.tableIndex, 1);
});

// === 4. matchLabelCells ===
check("matchLabelCells: 정규화 매칭(공백·콜론 흡수) + 우측 우선", () => {
  const cells = scanTableCells(section(infoTable()));
  const { matches, unmatched } = matchLabelCells(cells, [
    "기업명", // 셀 텍스트는 "기업명 (필수)" — 공백·괄호 흡수
    "사업자 등록번호", // 셀 텍스트는 "사업자등록번호" — 공백 흡수
    "이메일", // 셀 텍스트는 "이메일:" — 콜론 흡수
  ]);
  assert.equal(unmatched.length, 0);
  assert.equal(matches.length, 3);
  for (const m of matches) {
    assert.equal(m.direction, "right");
    assert.equal(m.targetCell.isEmpty, true);
    assert.equal(m.targetCell.colAddr, 1);
  }
});

check("matchLabelCells: 우측 없으면 하단 폴백", () => {
  const xml = section(
    tbl(
      tr(tc({ col: 0, row: 0, inner: runText("비고") })) +
        tr(tc({ col: 0, row: 1, inner: RUN_EMPTY_T })),
    ),
  );
  const cells = scanTableCells(xml);
  const { matches } = matchLabelCells(cells, ["비고"]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.direction, "below");
  assert.equal(matches[0]!.targetCell.rowAddr, 1);
});

check("matchLabelCells: 비어있지 않은 대상 셀은 스킵(덮어쓰기 금지)", () => {
  const xml = section(
    tbl(
      tr(
        tc({ col: 0, row: 0, inner: runText("대표자") }) +
          tc({ col: 1, row: 0, inner: runText("홍길동") }),
      ),
    ),
  );
  const cells = scanTableCells(xml);
  const { matches, unmatched } = matchLabelCells(cells, ["대표자"]);
  assert.equal(matches.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0]!.reason, "target_occupied");
});

check("matchLabelCells: 미매칭 라벨 → no_label_cell", () => {
  const cells = scanTableCells(section(infoTable()));
  const { matches, unmatched } = matchLabelCells(cells, ["존재하지않는항목"]);
  assert.equal(matches.length, 0);
  assert.equal(unmatched[0]!.reason, "no_label_cell");
});

// === 5. fillCells ===
check("fillCells: hp:t/ 스플라이스 무손실(역치환 복원) + 이스케이프(& < >)", () => {
  const xml = section(infoTable());
  const cells = scanTableCells(xml);
  const target = matchLabelCells(cells, ["기업명"]).matches[0]!.targetCell;

  const value = "값 & <b>";
  const out = fillCells(xml, [{ cell: target, value }]);
  const escaped = "값 &amp; &lt;b&gt;";
  assert.ok(out.includes(`<hp:t>${escaped}</hp:t>`), "이스케이프된 값 삽입");
  // 역치환 시 원본과 정확히 일치 → 삽입 지점 외 무손실.
  assert.equal(out.replace(`<hp:t>${escaped}</hp:t>`, "<hp:t/>"), xml);
});

check("fillCells: self-close hp:run 확장 경로 무손실", () => {
  const xml = section(infoTable());
  const cells = scanTableCells(xml);
  const target = matchLabelCells(cells, ["사업자등록번호"]).matches[0]!.targetCell;

  const out = fillCells(xml, [{ cell: target, value: "123-45-67890" }]);
  const expanded = `<hp:run charPrIDRef="7"><hp:t>123-45-67890</hp:t></hp:run>`;
  assert.ok(out.includes(expanded));
  assert.equal(out.replace(expanded, RUN_SELF_CLOSE), xml);
});

check("fillCells: 표 밖 <hp:t/> 스페이서 불변", () => {
  // 표 앞에 스페이서 <hp:t/> 문단을 두고, 표 안 대상 셀만 채운다.
  const spacer = `<hp:run charPrIDRef="1"><hp:t/></hp:run>`;
  const body = `${spacer}${infoTable()}`;
  const xml = section(body);
  const prefixEnd = xml.indexOf("<hp:tbl");
  const prefix = xml.slice(0, prefixEnd); // 스페이서 포함 접두부

  const cells = scanTableCells(xml);
  const target = matchLabelCells(cells, ["기업명"]).matches[0]!.targetCell;
  const out = fillCells(xml, [{ cell: target, value: "채움" }]);

  // 접두부(표 밖 스페이서 포함)는 바이트 그대로 보존.
  assert.ok(out.startsWith(prefix));
  // 표 밖 스페이서 <hp:t/> 는 그대로 남는다.
  assert.ok(out.slice(0, prefixEnd).includes("<hp:t/>"));
});

check("fillCells: 다중 셀 채움(오프셋 밀림 없음)", () => {
  const xml = section(infoTable());
  const cells = scanTableCells(xml);
  const { matches } = matchLabelCells(cells, ["기업명", "이메일"]);
  const fills = matches.map((m) => ({ cell: m.targetCell, value: `V-${m.label}` }));
  const out = fillCells(xml, fills);
  assert.ok(out.includes("<hp:t>V-기업명</hp:t>"));
  assert.ok(out.includes("<hp:t>V-이메일</hp:t>"));
});

// === 6. fillHwpxTemplate ===
function buildHwpx(sectionBody: string): { buf: Buffer; versionData: Buffer } {
  const versionData = Buffer.from("<hv:HCFVersion t* attr />", "utf8");
  const entries: HwpxEntry[] = [
    { name: "mimetype", data: Buffer.from("application/hwp+zip", "utf8"), method: 0 },
    { name: "version.xml", data: versionData, method: 8 },
    { name: "Contents/section0.xml", data: Buffer.from(section(sectionBody), "utf8"), method: 8 },
  ];
  return { buf: writeHwpx(entries), versionData };
}

check("fillHwpxTemplate: 정상 채움 + unfilled 보고 + 비수정 엔트리 바이트 동일", () => {
  const body =
    infoTable() +
    // 직인: 대상 셀이 hp:t/ 도 self-close run 도 아님 → unfillable.
    tbl(
      tr(
        tc({ col: 0, row: 0, inner: runText("직인") }) +
          tc({ col: 1, row: 0, inner: RUN_OPEN_CLOSE }),
      ),
    );
  const { buf, versionData } = buildHwpx(body);

  const result = fillHwpxTemplate({
    source: buf,
    values: {
      기업명: "주식회사 테스트",
      사업자등록번호: "123-45-67890",
      직인: "인장", // unfillable
      없는항목: "무시", // no_label_cell
    },
  });

  // filled: 기업명·사업자등록번호.
  const filledLabels = result.filled.map((f) => f.label).sort();
  assert.deepEqual(filledLabels, ["기업명", "사업자등록번호"]);
  assert.equal(result.filled.find((f) => f.label === "기업명")!.value, "주식회사 테스트");

  // unfilled: 직인(unfillable) + 없는항목(no_label_cell).
  const reasons = new Map(result.unfilled.map((u) => [u.label, u.reason]));
  assert.equal(reasons.get("직인"), "unfillable");
  assert.equal(reasons.get("없는항목"), "no_label_cell");

  // 산출물은 유효 hwpx: 매직 바이트 + 재파싱.
  assert.equal(detectHwpFormat(result.output), "hwpx");
  const out = readHwpxEntries(result.output);
  assert.equal(out[0]!.name, "mimetype");

  // 비수정 엔트리(version.xml) 바이트 동일.
  const version = out.find((e) => e.name === "version.xml")!;
  assert.ok(version.data.equals(versionData), "version.xml 바이트 보존");

  // 채운 값이 실제 섹션에 반영.
  const sec = out.find((e) => e.name === "Contents/section0.xml")!.data.toString("utf8");
  assert.ok(sec.includes("<hp:t>주식회사 테스트</hp:t>"));
  assert.ok(sec.includes("<hp:t>123-45-67890</hp:t>"));
});

check("fillHwpxTemplate: hwpx 아닌 소스는 예외", () => {
  const notHwpx = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]); // CFBF
  assert.throws(() => fillHwpxTemplate({ source: notHwpx, values: { a: "b" } }));
});

check("fillHwpxTemplate: 값 없음이면 원본 섹션 바이트 그대로", () => {
  const { buf } = buildHwpx(infoTable());
  const before = readHwpxEntries(buf).find((e) => e.name === "Contents/section0.xml")!.data;
  const result = fillHwpxTemplate({ source: buf, values: {} });
  const after = readHwpxEntries(result.output).find(
    (e) => e.name === "Contents/section0.xml",
  )!.data;
  assert.ok(before.equals(after));
  assert.equal(result.filled.length, 0);
  assert.equal(result.unfilled.length, 0);
});

// 타입 노출 확인(HwpxTableCell 사용처 컴파일 보증).
const _typecheck: HwpxTableCell | null = null;
void _typecheck;

console.log(`\n✅ ${passed}개 통과`);

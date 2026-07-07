/**
 * HWPX 원본 양식 채움 모듈 — docs/plans/2026-07-07-hwpx-fill-export.md Phase 1.
 *
 * 정부 표준 양식(.hwpx / OWPML, KS X 6101)의 "라벨 셀 + 빈 입력 셀" 표에 값을 채운다.
 * 설계 원칙(설계 결정 1~8):
 *  - zero-dep: node:zlib(inflateRawSync/deflateRawSync)·node:buffer 만 사용.
 *  - XML 재직렬화 금지: 원본 바이트를 보존하고 삽입 지점만 문자열 스플라이스.
 *  - 형식 판별은 확장자가 아니라 매직 바이트(PK=zip/hwpx vs D0CF11E0=CFBF/hwp 바이너리).
 *  - 빈 셀만 채움(덮어쓰기 금지). 라벨 미매칭·unfillable 은 정직하게 보고.
 *
 * zip 읽기(readHwpxEntries)/쓰기(writeHwpx)/crc32/escapeXml 은 Phase 0 스파이크
 * (scripts/spike/hwpx-fill-roundtrip.mjs)에서 라운드트립 검증된 로직을 TypeScript 로
 * 승격한 것이다(로직 변경 없이 타입만 부여).
 */
import { inflateRawSync, deflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

// =====================================================================
// 형식 판별 (매직 바이트)
// =====================================================================

/**
 * 매직 바이트로 한글 문서 형식을 판별한다. 확장자 판별 금지.
 *  - PK\x03\x04 (0x04034b50): zip 컨테이너 → hwpx 후보.
 *  - D0 CF 11 E0 (0xe011cfd0 LE): CFBF 복합 문서 → hwp 5.x 바이너리.
 *  - 그 외: unknown.
 */
export function detectHwpFormat(buf: Buffer): "hwpx" | "hwp-binary" | "unknown" {
  if (buf.length < 4) return "unknown";
  const magic = buf.readUInt32LE(0);
  if (magic === 0x04034b50) return "hwpx";
  if (magic === 0xe011cfd0) return "hwp-binary";
  return "unknown";
}

// =====================================================================
// zip 읽기 (central directory + inflateRaw) — 스파이크 승격, 로직 불변
// =====================================================================

export interface HwpxEntry {
  name: string;
  data: Buffer;
  /** 원본 압축 방식: 0=Stored, 8=Deflate (참고용 — writeHwpx 는 재계산). */
  method: number;
}

/** central directory 순서로 엔트리를 복원한다(디렉토리 엔트리 제외). */
export function readHwpxEntries(buf: Buffer): HwpxEntry[] {
  // EOCD(0x06054b50)를 뒤에서 탐색 (comment 최대 64KB)
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("EOCD not found (zip 아님?)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries: HwpxEntry[] = [];
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
    const data =
      method === 0
        ? Buffer.from(raw)
        : method === 8
          ? inflateRawSync(raw)
          : (() => {
              throw new Error(`미지원 압축 방식 ${method}: ${name}`);
            })();

    if (!name.endsWith("/")) entries.push({ name, data, method });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// =====================================================================
// zip 쓰기 (수제 writer) — 스파이크 승격, 로직 불변
// =====================================================================

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** mimetype 은 Stored·첫 엔트리, 나머지 Deflate. 디렉토리 엔트리 없음, UTF-8 플래그(0x0800). */
export function writeHwpx(entries: HwpxEntry[]): Buffer {
  const ordered: HwpxEntry[] = [
    ...entries.filter((e) => e.name === "mimetype"),
    ...entries.filter((e) => e.name !== "mimetype"),
  ];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
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

// =====================================================================
// XML 값 처리
// =====================================================================

/** & < > " ' 을 XML 엔티티로 치환 — 스파이크 승격, 로직 불변. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 기본 XML 엔티티·수치 참조를 원문자로 복원(셀 텍스트 매칭용). */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeFromCode(Number(d)))
    .replace(/&amp;/g, "&");
}

function safeFromCode(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

// 제어문자(개행/탭 포함) + DEL. 개행은 사전에 공백으로 치환하므로 여기서 제거되지 않는다.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
// 공백류(반각 + 전각 U+3000).
const WHITESPACE_RE = /[\s　]+/g;

/**
 * 채움 값 정규화: 개행→공백, 잔여 제어문자 제거, XML 이스케이프.
 * v1 은 단일 라인만 지원(설계 결정 5).
 */
function prepareValue(value: string): string {
  const singleLine = value.replace(/\r\n?|\n/g, " ");
  const stripped = singleLine.replace(CONTROL_CHARS_RE, "");
  return escapeXml(stripped);
}

// =====================================================================
// 표 셀 스캔
// =====================================================================

export interface HwpxTableCell {
  /** 문서 순서상 표 인덱스(중첩 표는 각기 다른 인덱스). */
  tableIndex: number;
  /** hp:cellAddr 의 colAddr. */
  colAddr: number;
  /** hp:cellAddr 의 rowAddr. */
  rowAddr: number;
  /** hp:cellSpan 의 colSpan(기본 1). */
  colSpan: number;
  /** hp:cellSpan 의 rowSpan(기본 1). */
  rowSpan: number;
  /** 셀 내 모든 hp:t 텍스트 연결(엔티티 복원). */
  text: string;
  /** 섹션 XML 내 셀 시작 오프셋(<hp:tc 위치). */
  startOffset: number;
  /** 섹션 XML 내 셀 끝 오프셋(</hp:tc> 직후). */
  endOffset: number;
  /** 텍스트가 공백뿐이면 true. */
  isEmpty: boolean;
}

// hp:tbl / hp:tc 개폐 + cellAddr / cellSpan 을 한 번에 토큰화.
const TOKEN_RE = /<\/?hp:tbl\b[^>]*>|<\/?hp:tc\b[^>]*>|<hp:cellAddr\b[^>]*>|<hp:cellSpan\b[^>]*>/g;
const HP_T_RE = /<hp:t>([\s\S]*?)<\/hp:t>/g;

interface CellFrame {
  startOffset: number;
  tableIndex: number;
  colAddr: number;
  rowAddr: number;
  colSpan: number;
  rowSpan: number;
  addrSet: boolean;
  spanSet: boolean;
}

/**
 * 섹션 XML 을 문자열 스캔해 표 셀을 추출한다.
 * 중첩 표는 스택으로 정확히 분리하며, 각 셀의 고유 cellAddr/cellSpan 을 귀속한다.
 */
export function scanTableCells(sectionXml: string): HwpxTableCell[] {
  const cells: HwpxTableCell[] = [];
  const tableStack: number[] = [];
  const cellStack: CellFrame[] = [];
  let nextTableIndex = 0;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(sectionXml)) !== null) {
    const tok = m[0];
    const at = m.index;

    if (tok.startsWith("</hp:tbl")) {
      tableStack.pop();
    } else if (tok.startsWith("<hp:tbl")) {
      tableStack.push(nextTableIndex++);
    } else if (tok.startsWith("</hp:tc")) {
      const frame = cellStack.pop();
      if (!frame) continue;
      const endOffset = at + tok.length;
      const slice = sectionXml.slice(frame.startOffset, endOffset);
      cells.push(finalizeCell(frame, endOffset, slice));
    } else if (tok.startsWith("<hp:tc")) {
      cellStack.push({
        startOffset: at,
        tableIndex: tableStack.length > 0 ? tableStack[tableStack.length - 1]! : -1,
        colAddr: -1,
        rowAddr: -1,
        colSpan: 1,
        rowSpan: 1,
        addrSet: false,
        spanSet: false,
      });
    } else if (tok.startsWith("<hp:cellAddr")) {
      const top = cellStack[cellStack.length - 1];
      if (top && !top.addrSet) {
        const col = /colAddr="(\d+)"/.exec(tok);
        const row = /rowAddr="(\d+)"/.exec(tok);
        if (col) top.colAddr = Number(col[1]);
        if (row) top.rowAddr = Number(row[1]);
        top.addrSet = true;
      }
    } else if (tok.startsWith("<hp:cellSpan")) {
      const top = cellStack[cellStack.length - 1];
      if (top && !top.spanSet) {
        const col = /colSpan="(\d+)"/.exec(tok);
        const row = /rowSpan="(\d+)"/.exec(tok);
        if (col) top.colSpan = Number(col[1]);
        if (row) top.rowSpan = Number(row[1]);
        top.spanSet = true;
      }
    }
  }
  return cells;
}

function finalizeCell(frame: CellFrame, endOffset: number, slice: string): HwpxTableCell {
  HP_T_RE.lastIndex = 0;
  let raw = "";
  let tm: RegExpExecArray | null;
  while ((tm = HP_T_RE.exec(slice)) !== null) raw += tm[1] ?? "";
  const text = decodeXml(raw);
  const isEmpty = text.replace(WHITESPACE_RE, "") === "";
  return {
    tableIndex: frame.tableIndex,
    colAddr: frame.colAddr,
    rowAddr: frame.rowAddr,
    colSpan: frame.colSpan,
    rowSpan: frame.rowSpan,
    text,
    startOffset: frame.startOffset,
    endOffset,
    isEmpty,
  };
}

// =====================================================================
// 라벨 매칭
// =====================================================================

/** 라벨 정규화: 괄호 내용·마커·콜론·공백 제거(공백·콜론 차이 흡수). */
function normalizeLabel(s: string): string {
  return s
    .replace(/\([^()]*\)/g, "") // (…) 내용 제거: "기업명(필수 입력)" → "기업명"
    .replace(/（[^（）]*）/g, "") // 전각 괄호
    .replace(/[※★☆◆■□▶►▷◎●○*]/g, "") // 마커
    .replace(/[：:]/g, "") // 콜론(전각/반각)
    .replace(WHITESPACE_RE, "") // 공백(전각 포함)
    .replace(/[()（）[\]「」【】]/g, "") // 잔여 괄호 문자
    .toLowerCase();
}

export type UnmatchedReason =
  | "no_label_cell"
  | "no_adjacent_cell"
  | "target_occupied"
  | "unfillable";

export interface HwpxLabelMatch {
  label: string;
  labelCell: HwpxTableCell;
  targetCell: HwpxTableCell;
  direction: "right" | "below";
}

export interface MatchLabelCellsResult {
  matches: HwpxLabelMatch[];
  unmatched: Array<{ label: string; reason: UnmatchedReason }>;
}

/**
 * 라벨 목록을 셀에 매핑한다.
 * 라벨 정규화 후 동일한 텍스트의 (비어있지 않은) 셀을 라벨 셀로 잡고,
 * 우측 인접(colAddr+colSpan, 같은 rowAddr) 우선, 없으면 하단 인접(rowAddr+rowSpan, 같은 colAddr)을
 * 대상으로 삼는다. 대상은 빈 셀이어야 하며(덮어쓰기 금지) 아니면 스킵한다.
 */
export function matchLabelCells(cells: HwpxTableCell[], labels: string[]): MatchLabelCellsResult {
  const matches: HwpxLabelMatch[] = [];
  const unmatched: Array<{ label: string; reason: UnmatchedReason }> = [];
  const normCells = cells.map((c) => normalizeLabel(c.text));

  for (const label of labels) {
    const nl = normalizeLabel(label);
    if (nl === "") {
      unmatched.push({ label, reason: "no_label_cell" });
      continue;
    }
    const li = normCells.findIndex((n, i) => n === nl && !cells[i]!.isEmpty);
    if (li < 0) {
      unmatched.push({ label, reason: "no_label_cell" });
      continue;
    }
    const labelCell = cells[li]!;
    const right = cells.find(
      (c) =>
        c.tableIndex === labelCell.tableIndex &&
        c.rowAddr === labelCell.rowAddr &&
        c.colAddr === labelCell.colAddr + labelCell.colSpan,
    );
    const below = cells.find(
      (c) =>
        c.tableIndex === labelCell.tableIndex &&
        c.colAddr === labelCell.colAddr &&
        c.rowAddr === labelCell.rowAddr + labelCell.rowSpan,
    );
    const candidate = right ?? below;
    if (!candidate) {
      unmatched.push({ label, reason: "no_adjacent_cell" });
      continue;
    }
    if (!candidate.isEmpty) {
      unmatched.push({ label, reason: "target_occupied" });
      continue;
    }
    matches.push({
      label,
      labelCell,
      targetCell: candidate,
      direction: candidate === right ? "right" : "below",
    });
  }

  return { matches, unmatched };
}

// =====================================================================
// 셀 채움 (바이트 보존 스플라이스)
// =====================================================================

const HP_T_EMPTY = "<hp:t/>";
const HP_RUN_SELF_CLOSE_RE = /<hp:run\b[^>]*\/>/;

interface CellSplice {
  start: number;
  end: number;
  text: string;
}

/**
 * 대상 셀 내부에서 삽입 지점을 찾는다.
 *  1) 첫 <hp:t/> → <hp:t>값</hp:t>
 *  2) <hp:t/> 없고 self-closing <hp:run …/> 있으면 <hp:run …><hp:t>값</hp:t></hp:run>
 *  3) 둘 다 없으면 null(unfillable)
 * 오프셋은 섹션 XML 기준 절대값. 값은 이스케이프 완료.
 */
function planCellFill(sectionXml: string, cell: HwpxTableCell, value: string): CellSplice | null {
  const cellXml = sectionXml.slice(cell.startOffset, cell.endOffset);
  const esc = prepareValue(value);

  const emptyAt = cellXml.indexOf(HP_T_EMPTY);
  if (emptyAt >= 0) {
    const start = cell.startOffset + emptyAt;
    return { start, end: start + HP_T_EMPTY.length, text: `<hp:t>${esc}</hp:t>` };
  }

  const runMatch = HP_RUN_SELF_CLOSE_RE.exec(cellXml);
  if (runMatch) {
    const runTag = runMatch[0];
    const openTag = `${runTag.slice(0, -2)}>`; // "…/>" → "…>"
    const start = cell.startOffset + runMatch.index;
    return {
      start,
      end: start + runTag.length,
      text: `${openTag}<hp:t>${esc}</hp:t></hp:run>`,
    };
  }

  return null;
}

/**
 * 대상 셀들에 값을 삽입한 새 섹션 XML 을 반환한다.
 * XML 재직렬화 없이 삽입 지점만 스플라이스한다. unfillable 셀은 조용히 건너뛴다
 * (보고는 fillHwpxTemplate 이 담당). 표 밖 <hp:t/> 스페이서는 대상 셀 범위 밖이므로 불변.
 */
export function fillCells(
  sectionXml: string,
  fills: Array<{ cell: HwpxTableCell; value: string }>,
): string {
  const splices: CellSplice[] = [];
  for (const { cell, value } of fills) {
    const plan = planCellFill(sectionXml, cell, value);
    if (plan) splices.push(plan);
  }
  // 오프셋 밀림 방지 — 뒤에서 앞으로 스플라이스.
  splices.sort((a, b) => b.start - a.start);
  let out = sectionXml;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

// =====================================================================
// 오케스트레이터
// =====================================================================

export interface FillHwpxTemplateInput {
  source: Buffer;
  values: Record<string, string>;
}

export interface FillHwpxTemplateResult {
  output: Buffer;
  filled: Array<{ label: string; value: string }>;
  unfilled: Array<{ label: string; reason: UnmatchedReason }>;
}

const SECTION_NAME_RE = /^Contents\/section\d+\.xml$/;

const REASON_PRIORITY: Record<UnmatchedReason, number> = {
  unfillable: 3,
  target_occupied: 2,
  no_adjacent_cell: 1,
  no_label_cell: 0,
};

function noteReason(map: Map<string, UnmatchedReason>, label: string, reason: UnmatchedReason): void {
  const cur = map.get(label);
  if (cur === undefined || REASON_PRIORITY[reason] > REASON_PRIORITY[cur]) map.set(label, reason);
}

/**
 * 원본 hwpx 템플릿에 값을 채워 새 hwpx 를 만든다.
 * Contents/section*.xml 을 전부 순회하며 라벨 매칭→빈 셀 채움을 수행하고,
 * 미매칭·unfillable 라벨은 reason 과 함께 unfilled 로 보고한다(부분 채움 정직화).
 */
export function fillHwpxTemplate(input: FillHwpxTemplateInput): FillHwpxTemplateResult {
  if (detectHwpFormat(input.source) !== "hwpx") {
    throw new Error("hwpx 컨테이너가 아님(매직 바이트 불일치)");
  }
  const entries = readHwpxEntries(input.source);
  const labels = Object.keys(input.values);
  const resolved = new Map<string, string>(); // label → 채워진 값
  const reasonByLabel = new Map<string, UnmatchedReason>();

  const newEntries = entries.map<HwpxEntry>((entry) => {
    if (!SECTION_NAME_RE.test(entry.name)) return entry;
    const xml = entry.data.toString("utf8");
    const cells = scanTableCells(xml);
    const pending = labels.filter((l) => !resolved.has(l));
    if (pending.length === 0) return entry;

    const { matches, unmatched } = matchLabelCells(cells, pending);
    const fills: Array<{ cell: HwpxTableCell; value: string }> = [];
    for (const match of matches) {
      const value = input.values[match.label] ?? "";
      const plan = planCellFill(xml, match.targetCell, value);
      if (!plan) {
        noteReason(reasonByLabel, match.label, "unfillable");
        continue;
      }
      fills.push({ cell: match.targetCell, value });
      resolved.set(match.label, value);
    }
    for (const u of unmatched) noteReason(reasonByLabel, u.label, u.reason);

    if (fills.length === 0) return entry;
    const filledXml = fillCells(xml, fills);
    return { name: entry.name, data: Buffer.from(filledXml, "utf8"), method: entry.method };
  });

  const output = writeHwpx(newEntries);
  const filled = labels
    .filter((l) => resolved.has(l))
    .map((l) => ({ label: l, value: resolved.get(l)! }));
  const unfilled = labels
    .filter((l) => !resolved.has(l))
    .map((l) => ({ label: l, reason: reasonByLabel.get(l) ?? ("no_label_cell" as UnmatchedReason) }));

  return { output, filled, unfilled };
}

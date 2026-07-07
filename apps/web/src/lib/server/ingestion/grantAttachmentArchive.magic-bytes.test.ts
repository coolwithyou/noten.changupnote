/**
 * 첨부 포맷 매직 바이트 판별 단위 테스트 (node:assert/strict, tsx 실행).
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *         apps/web/src/lib/server/ingestion/grantAttachmentArchive.magic-bytes.test.ts
 *
 * 설계 결정 6(docs/plans/2026-07-07-hwpx-fill-export.md): 첨부 포맷 판별을 확장자에서 매직 바이트로 보강.
 * 실측 근거(2026-07-07): `.hwpx` 확장자를 단 hwp 바이너리 위장 파일이 스파이크 14건 중 3건 발견.
 *
 * 커버:
 *  1) detectConvertibleSurfaceFormatFromBytes: 위장 hwpx(CFBF)→"hwp" 교정, 진짜 hwpx(PK)→"hwpx" 유지,
 *     .hwp/.hwpx unknown 매직→null(보수적), pdf/docx 는 확장자 유지(매직 미적용), 비대상 확장자→null.
 *  2) attach/readDetectedSurfaceFormat 왕복.
 *  3) registerAttachmentConversions: detectedFormat 가 확장자보다 우선, 바이트 부재 시 확장자 폴백,
 *     detectedFormat=null 이면 skip, 비대상 확장자 skip.
 *
 * 실 DB/R2 의존 없음 — 인메모리 픽스처 + 체이너블 fake drizzle 세션만 사용.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { GrantSource } from "@cunote/contracts";
import type { CunoteDbSession } from "../db/client";
import {
  attachDetectedSurfaceFormat,
  detectConvertibleSurfaceFormat,
  detectConvertibleSurfaceFormatFromBytes,
  readDetectedSurfaceFormat,
} from "./grantAttachmentArchive";
import {
  registerAttachmentConversions,
  type ArchivedAttachmentRef,
} from "../conversion/registerAttachmentConversions";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

// ---------------------------------------------------------------------
// 매직 바이트 픽스처 (앞 4바이트만 detectHwpFormat 이 읽는다)
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]); // zip/hwpx 컨테이너
const CFBF = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // CFBF/구형 hwp 바이너리
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF- (hwp/hwpx 어느 쪽도 아님)

// ---------------------------------------------------------------------
// 1. detectConvertibleSurfaceFormatFromBytes
async function main(): Promise<void> {
  await check("위장 hwpx(.hwpx + CFBF 시그니처) → 'hwp' 로 교정 (매직이 이긴다)", () => {
    assert.equal(detectConvertibleSurfaceFormatFromBytes("서식.hwpx", CFBF), "hwp");
  });

  await check("진짜 hwpx(.hwpx + PK 시그니처) → 'hwpx' 유지", () => {
    assert.equal(detectConvertibleSurfaceFormatFromBytes("서식.hwpx", PK), "hwpx");
  });

  await check("진짜 hwp(.hwp + CFBF) → 'hwp' 유지", () => {
    assert.equal(detectConvertibleSurfaceFormatFromBytes("서식.hwp", CFBF), "hwp");
  });

  await check("위장 hwp(.hwp + PK zip 컨테이너) → 'hwpx' 로 교정 (대칭 케이스)", () => {
    assert.equal(detectConvertibleSurfaceFormatFromBytes("서식.hwp", PK), "hwpx");
  });

  await check(".hwpx + 정체불명 매직(%PDF) → null (보수적으로 surface 미생성)", () => {
    assert.equal(detectConvertibleSurfaceFormatFromBytes("서식.hwpx", PDF), null);
  });

  await check("pdf/docx 는 매직을 적용하지 않고 확장자 유지 (PK 바이트여도 그대로)", () => {
    // .docx 는 실제로 PK zip 이지만 hwpx 로 오인하지 않는다(hancom 확장자만 매직 적용).
    assert.equal(detectConvertibleSurfaceFormatFromBytes("붙임.docx", PK), "docx");
    assert.equal(detectConvertibleSurfaceFormatFromBytes("붙임.pdf", PK), "pdf");
    // 매직이 CFBF 여도 pdf/docx 확장자는 확장자 판별을 유지.
    assert.equal(detectConvertibleSurfaceFormatFromBytes("붙임.pdf", CFBF), "pdf");
  });

  await check("비대상 확장자(.zip)는 PK 여도 null (변환 대상 아님)", () => {
    assert.equal(detectConvertibleSurfaceFormatFromBytes("첨부.zip", PK), null);
    assert.equal(detectConvertibleSurfaceFormat("첨부.zip"), null);
  });

  // -------------------------------------------------------------------
  // 2. attach / readDetectedSurfaceFormat 왕복
  await check("attach → read 왕복: 'hwp' 실어두면 'hwp' 로 읽힌다", () => {
    const attachment: Record<string, unknown> = { filename: "서식.hwpx" };
    attachDetectedSurfaceFormat(attachment as never, "hwp");
    assert.equal(readDetectedSurfaceFormat(attachment), "hwp");
  });

  await check("attach(null) → read 는 null (바이트 검출했으나 대상 아님)", () => {
    const attachment: Record<string, unknown> = { filename: "서식.hwpx" };
    attachDetectedSurfaceFormat(attachment as never, null);
    assert.equal(readDetectedSurfaceFormat(attachment), null);
  });

  await check("키가 없는 첨부 → read 는 undefined (byte-less 폴백 신호)", () => {
    assert.equal(readDetectedSurfaceFormat({ filename: "서식.hwpx" }), undefined);
    assert.equal(readDetectedSurfaceFormat(null), undefined);
    assert.equal(readDetectedSurfaceFormat("문자열"), undefined);
  });

  // -------------------------------------------------------------------
  // 3. registerAttachmentConversions 통합 (fake drizzle 세션, client=null)
  await check("detectedFormat='hwp' 는 확장자 .hwpx 를 이기고 surface.format='hwp'", async () => {
    const { db, inserts } = makeFakeDb();
    const result = await registerAttachmentConversions(db, {
      grantId: "grant-1",
      source: SOURCE,
      sourceId: "src-1",
      client: null,
      attachments: [ref({ filename: "위장.hwpx", detectedFormat: "hwp" })],
    });
    assert.equal(result.surfacesUpserted, 1);
    assert.equal(result.skipped, 0);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]?.format, "hwp");
  });

  await check("detectedFormat 생략 시 확장자(.hwpx)로 폴백 → surface.format='hwpx'", async () => {
    const { db, inserts } = makeFakeDb();
    const result = await registerAttachmentConversions(db, {
      grantId: "grant-1",
      source: SOURCE,
      sourceId: "src-1",
      client: null,
      attachments: [ref({ filename: "정상.hwpx" })], // detectedFormat 없음(byte-less)
    });
    assert.equal(result.surfacesUpserted, 1);
    assert.equal(inserts[0]?.format, "hwpx");
  });

  await check("detectedFormat=null 이면 확장자로 되살리지 않고 skip", async () => {
    const { db, inserts } = makeFakeDb();
    const result = await registerAttachmentConversions(db, {
      grantId: "grant-1",
      source: SOURCE,
      sourceId: "src-1",
      client: null,
      attachments: [ref({ filename: "정체불명.hwpx", detectedFormat: null })],
    });
    assert.equal(result.surfacesUpserted, 0);
    assert.equal(result.skipped, 1);
    assert.equal(inserts.length, 0);
  });

  await check("비대상 확장자(.zip, detectedFormat 생략)는 skip", async () => {
    const { db, inserts } = makeFakeDb();
    const result = await registerAttachmentConversions(db, {
      grantId: "grant-1",
      source: SOURCE,
      sourceId: "src-1",
      client: null,
      attachments: [ref({ filename: "첨부.zip" })],
    });
    assert.equal(result.surfacesUpserted, 0);
    assert.equal(result.skipped, 1);
    assert.equal(inserts.length, 0);
  });

  console.log(`\n${passed} passed`);
}

// ---------------------------------------------------------------------
const SOURCE: GrantSource = "bizinfo";

function ref(over: Partial<ArchivedAttachmentRef> & { filename: string }): ArchivedAttachmentRef {
  return {
    storageKey: "grant-archive/bizinfo/src-1/attachments/key",
    archiveUrl: "https://r2.example/archive",
    sourceUri: "https://origin.example/file",
    sha256: "abc123",
    ...over,
  };
}

/** upsertApplicationSurface 가 쓰는 select/insert/update 체인만 흉내 내는 인메모리 세션. */
function makeFakeDb(): { db: CunoteDbSession; inserts: Array<Record<string, unknown>> } {
  const inserts: Array<Record<string, unknown>> = [];
  const selectBuilder = {
    from() {
      return selectBuilder;
    },
    where() {
      return selectBuilder;
    },
    limit() {
      // 기존 surface 없음 → insert 경로.
      return Promise.resolve([] as unknown[]);
    },
  };
  const db = {
    select() {
      return selectBuilder;
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          inserts.push(value);
          return Promise.resolve();
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as CunoteDbSession, inserts };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

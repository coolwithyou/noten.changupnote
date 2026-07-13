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
import { writeHwpx } from "@cunote/core/documents/hwpx-fill";
import type { CunoteDbSession } from "../db/client";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  archiveGrantAttachments,
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

  await check("UTF-8 txt 첨부는 별도 변환 서버 없이 markdown으로 보관", async () => {
    const uploads: Array<{ key: string; contentType: string; body: Buffer | string }> = [];
    const storage = {
      async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
        uploads.push(input);
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
    } as R2ObjectStorage;
    const result = await archiveGrantAttachments([{
      filename: "포스터 대체텍스트.txt",
      url: "https://origin.example/poster.txt",
    }], {
      source: "kstartup",
      sourceId: "178373",
      collectedAt: new Date("2026-07-12T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: false,
      storage,
      fetchImpl: (async () => new Response("지원대상: 창업기업", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })) as typeof fetch,
    });
    assert.equal(result.archivedCount, 1);
    assert.equal(result.convertedCount, 1);
    assert.equal(result.attachments[0]?.conversion?.status, "converted");
    assert.equal(result.attachments[0]?.conversion?.converter, "plain-text-v1");
    assert.equal(result.attachmentMarkdowns[0]?.markdown, "지원대상: 창업기업");
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0]?.contentType, "text/plain; charset=utf-8");
    assert.equal(uploads[1]?.contentType, "text/markdown; charset=utf-8");
  });

  await check("ZIP 첨부는 안전한 내부 문서를 별도 archive 항목으로 확장", async () => {
    const uploads: Array<{ key: string; contentType: string }> = [];
    const storage = {
      async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
        uploads.push({ key: input.key, contentType: input.contentType });
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
    } as R2ObjectStorage;
    const zip = writeHwpx([{ name: "notice.txt", data: Buffer.from("지원대상: 중소기업"), method: 0 }]);
    const result = await archiveGrantAttachments([{
      filename: "첨부파일.zip",
      url: "https://origin.example/bundle.zip",
    }], {
      source: "bizinfo",
      sourceId: "PBLN_TEST",
      collectedAt: new Date("2026-07-12T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: false,
      storage,
      fetchImpl: (async () => new Response(new Uint8Array(zip), {
        status: 200,
        headers: { "content-type": "application/zip" },
      })) as typeof fetch,
    });
    assert.equal(result.archivedCount, 2);
    assert.equal(result.convertedCount, 1);
    assert.equal(result.attachments[0]?.conversion?.status, "skipped");
    assert.equal(result.attachments[1]?.conversion?.status, "converted");
    assert.match(result.attachments[1]?.filename ?? "", /\.txt$/);
    assert.match(result.attachmentMarkdowns[0]?.markdown ?? "", /지원대상: 중소기업/);
    assert.equal(uploads.length, 3);
  });

  await check("XLSX 첨부는 shared strings와 worksheet 값을 markdown으로 변환", async () => {
    const uploads: string[] = [];
    const storage = {
      async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
        uploads.push(input.key);
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
    } as R2ObjectStorage;
    const xlsx = writeHwpx([
      { name: "xl/sharedStrings.xml", data: Buffer.from('<sst><si><t>지원대상</t></si><si><t>중소기업</t></si></sst>'), method: 0 },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>'), method: 0 },
    ]);
    const result = await archiveGrantAttachments([{
      filename: "지원목록.xlsx",
      url: "https://origin.example/list.xlsx",
    }], {
      source: "bizinfo",
      sourceId: "PBLN_XLSX",
      collectedAt: new Date("2026-07-12T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: false,
      storage,
      fetchImpl: (async () => new Response(new Uint8Array(xlsx), { status: 200 })) as typeof fetch,
    });
    assert.equal(result.archivedCount, 1);
    assert.equal(result.convertedCount, 1);
    assert.equal(result.attachments[0]?.conversion?.converter, "office-openxml-v1");
    assert.match(result.attachmentMarkdowns[0]?.markdown ?? "", /지원대상 \| 중소기업/);
    assert.equal(uploads.length, 2);
  });

  await check("이미지 OCR은 신뢰도와 provider를 conversion provenance로 보관", async () => {
    const storage = {
      async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
    } as R2ObjectStorage;
    const result = await archiveGrantAttachments([{
      filename: "모집공고.png",
      url: "https://origin.example/notice.png",
    }], {
      source: "bizinfo",
      sourceId: "PBLN_IMAGE",
      collectedAt: new Date("2026-07-12T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: false,
      storage,
      fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch,
      imageOcr: async () => ({
        markdown: "지원대상: 서울특별시에 소재한 중소기업 및 소상공인",
        confidence: 0.82,
        provider: "test_vision",
        converter: "test-vision-v1",
      }),
    });
    assert.equal(result.convertedCount, 1);
    assert.equal(result.attachments[0]?.conversion?.ocr_provider, "test_vision");
    assert.equal(result.attachments[0]?.conversion?.ocr_confidence, 0.82);
  });

  await check("낮은 신뢰도의 이미지 OCR은 converted로 승격하지 않음", async () => {
    const storage = {
      async putObject(input: { key: string; body: Buffer | string; contentType: string }) {
        return { key: input.key, url: `https://r2.example/${input.key}` };
      },
    } as R2ObjectStorage;
    const result = await archiveGrantAttachments([{
      filename: "흐린공고.jpg",
      url: "https://origin.example/blurry.jpg",
    }], {
      source: "bizinfo",
      sourceId: "PBLN_LOW_OCR",
      collectedAt: new Date("2026-07-12T00:00:00.000Z"),
      enabled: true,
      convertHwp: true,
      autoInstallPyhwp: false,
      allowFailures: true,
      storage,
      fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch,
      imageOcr: async () => ({
        markdown: "인식은 되었지만 신뢰도가 낮은 공고 텍스트",
        confidence: 0.4,
        provider: "test_vision",
        converter: "test-vision-v1",
      }),
    });
    assert.equal(result.convertedCount, 0);
    assert.equal(result.failureCount, 1);
    assert.equal(result.attachments[0]?.conversion?.status, "failed");
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

  await check("filename 기반 legacy surface는 storageKey 정체성으로 승격되고 중복 insert하지 않는다", async () => {
    const { db, inserts, updates } = makeFakeDb([[], [{ id: "legacy-surface" }]]);
    const result = await registerAttachmentConversions(db, {
      grantId: "grant-1",
      source: SOURCE,
      sourceId: "src-1",
      client: null,
      attachments: [ref({ filename: "모집공고.pdf", storageKey: "grant-archive/body.pdf" })],
    });
    assert.equal(result.surfacesUpserted, 1);
    assert.equal(inserts.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.sourceAttachment, "grant-archive/body.pdf");
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
function makeFakeDb(selectResponses: unknown[][] = []): {
  db: CunoteDbSession;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let selectIndex = 0;
  const selectBuilder = {
    from() {
      return selectBuilder;
    },
    where() {
      return selectBuilder;
    },
    limit() {
      return Promise.resolve(selectResponses[selectIndex++] ?? []);
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
        set(value: Record<string, unknown>) {
          updates.push(value);
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as CunoteDbSession, inserts, updates };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

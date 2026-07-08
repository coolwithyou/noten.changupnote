/**
 * hwp2hwpx 트랙 Phase 2 — 플래그 판정 + 템플릿 해석 분기 단위 테스트 (node:assert/strict, tsx 실행).
 *
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *         apps/web/src/lib/server/documents/draftHwpxExport.hwp2hwpx.test.ts
 *
 * 설계: docs/plans/2026-07-08-hwp2hwpx-track.md Phase 2 — web 배선.
 *  - hwpxTemplateAvailable 플래그가 (1) .hwpx 보관 원본 (2) hwp 원본 + hwp2hwpx sibling(kind="hwpx")
 *    두 경로를 인식한다.
 *  - 다운로드 템플릿 해석이 hwpx 원본은 그대로, hwp 원본은 sibling 변환본으로 합류하고
 *    sibling 부재 시 정직한 미준비 에러를 던진다.
 *
 * 순수 함수(resolveHwpxTemplateAvailability / resolveHwpxTemplateSource)만 검증한다 — 실 DB/R2 의존 없음.
 * (magic-bytes.test.ts 선례의 tsx 실행 + 카운팅 스타일 준수.)
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { DraftableDocument } from "@cunote/contracts";
import {
  DraftHwpxExportError,
  resolveHwpxTemplateAvailability,
  resolveHwpxTemplateSource,
} from "./draftHwpxExport";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

// 매직 바이트 픽스처(앞 4바이트만 detectHwpFormat 이 읽는다).
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // hwpx(zip 컨테이너)
const CFBF = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // 구형 hwp 바이너리
const SIBLING = Buffer.concat([PK, Buffer.from("sibling-hwpx")]); // hwp2hwpx 변환본(hwpx)

function doc(over: Partial<DraftableDocument> & { sourceAttachment: string | null }): DraftableDocument {
  return {
    documentKey: "doc-1",
    name: "사업계획서",
    category: "other",
    canonicalName: "사업계획서",
    templateRequired: true,
    confidence: null,
    status: "not_started",
    hwpxTemplateAvailable: false,
    ...over,
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------
  // 1. 플래그 판정 (resolveHwpxTemplateAvailability)
  await check(".hwpx 보관 원본 → hwpxTemplateAvailable=true", () => {
    const [out] = resolveHwpxTemplateAvailability({
      documents: [doc({ sourceAttachment: "서식.hwpx" })],
      hwpxArchiveFilenames: new Set(["서식.hwpx"]),
      hwpxSiblingFilenames: new Set(),
    });
    assert.equal(out?.hwpxTemplateAvailable, true);
  });

  await check(".hwp 원본 + sibling artifact 있음 → true(신규 경로)", () => {
    const [out] = resolveHwpxTemplateAvailability({
      documents: [doc({ sourceAttachment: "서식.hwp" })],
      hwpxArchiveFilenames: new Set(), // .hwp 라 보관 원본 집합엔 없음
      hwpxSiblingFilenames: new Set(["서식.hwp"]), // surface.title = 첨부 파일명
    });
    assert.equal(out?.hwpxTemplateAvailable, true);
  });

  await check(".hwp 원본 + sibling artifact 없음 → false(불변)", () => {
    const [out] = resolveHwpxTemplateAvailability({
      documents: [doc({ sourceAttachment: "서식.hwp" })],
      hwpxArchiveFilenames: new Set(),
      hwpxSiblingFilenames: new Set(),
    });
    assert.equal(out?.hwpxTemplateAvailable, false);
  });

  await check("sourceAttachment 없음(null) → false(첨부 미연결)", () => {
    const [out] = resolveHwpxTemplateAvailability({
      documents: [doc({ sourceAttachment: null })],
      hwpxArchiveFilenames: new Set(["서식.hwpx"]),
      hwpxSiblingFilenames: new Set(["서식.hwp"]),
    });
    assert.equal(out?.hwpxTemplateAvailable, false);
  });

  await check("두 집합 모두 비면 문서 배열을 그대로 반환(무변경)", () => {
    const docs = [doc({ sourceAttachment: "서식.hwpx" })];
    const out = resolveHwpxTemplateAvailability({
      documents: docs,
      hwpxArchiveFilenames: new Set(),
      hwpxSiblingFilenames: new Set(),
    });
    assert.equal(out, docs); // 동일 참조 반환(단락)
  });

  await check("혼재: 매칭 안 되는 문서는 false 유지, 매칭 문서만 true", () => {
    const out = resolveHwpxTemplateAvailability({
      documents: [
        doc({ documentKey: "a", sourceAttachment: "A.hwpx" }),
        doc({ documentKey: "b", sourceAttachment: "B.hwp" }),
        doc({ documentKey: "c", sourceAttachment: "C.pdf" }),
      ],
      hwpxArchiveFilenames: new Set(["A.hwpx"]),
      hwpxSiblingFilenames: new Set(["B.hwp"]),
    });
    assert.deepEqual(
      out.map((d) => d.hwpxTemplateAvailable),
      [true, true, false],
    );
  });

  // -------------------------------------------------------------------
  // 2. 템플릿 해석 분기 (resolveHwpxTemplateSource)
  await check("보관 원본이 hwpx → archiveBytes 그대로, sibling 로더 미호출", async () => {
    let siblingCalled = false;
    const source = await resolveHwpxTemplateSource({
      archiveBytes: PK,
      loadSiblingBytes: async () => {
        siblingCalled = true;
        return SIBLING;
      },
    });
    assert.equal(source, PK);
    assert.equal(siblingCalled, false);
  });

  await check("원본이 hwp 바이너리 + sibling 있음 → sibling 변환본 사용", async () => {
    const source = await resolveHwpxTemplateSource({
      archiveBytes: CFBF,
      loadSiblingBytes: async () => SIBLING,
    });
    assert.equal(source, SIBLING);
  });

  await check("원본이 hwp 바이너리 + sibling 없음 → 정직한 미준비 에러(409)", async () => {
    await assert.rejects(
      resolveHwpxTemplateSource({
        archiveBytes: CFBF,
        loadSiblingBytes: async () => null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DraftHwpxExportError);
        assert.equal(error.code, "hwpx_sibling_not_ready");
        assert.equal(error.status, 409);
        assert.match(error.message, /hwp 형식이며 아직 hwpx 변환본이 준비되지 않았습니다/);
        return true;
      },
    );
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

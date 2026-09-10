// assembleLabInput 첨부 고지 단위 테스트 — R2 실호출 없이 storage 주입으로 검증.
// 핵심: markdown 미생성 첨부(변환 실패·미시도)가 조용히 사라지지 않고
// blocks 메타(첨부 미투입)와 모델 고지([입력 한계 고지])에 나타나야 한다(178352 실사례 회귀 방지).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import {
  applyLabVerifiedConversionArtifacts,
  assembleLabInput,
  type LabAttachmentTextStorage,
  type LabInputArchive,
} from "./input";

const GRANT = {
  source: "kstartup",
  sourceId: "178352",
  title: "테스트 공고",
  agencyOperator: "테스트 기관",
  agencyJurisdiction: null,
  applyStart: null,
  applyEnd: null,
  applyMethod: null,
  supportAmount: null,
  benefits: null,
};

function archive(partial: Partial<LabInputArchive> & { filename: string }): LabInputArchive {
  return { markdownStorageKey: null, markdownBytes: null, ...partial };
}

const fakeStorage = (objects: Record<string, string>): LabAttachmentTextStorage => ({
  async getObjectText(key: string) {
    const body = objects[key];
    if (body === undefined) throw new Error(`no such key: ${key}`);
    return body;
  },
});

function sha256(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function zipCoverageFixture(input: {
  memberCount?: number;
  markdownBody?: (index: number) => string;
  nested?: boolean;
} = {}) {
  const parentUri = "https://example.com/seq25/붙임파일.zip";
  const memberCount = input.memberCount ?? 5;
  const members = Array.from({ length: memberCount }, (_, offset) => {
    const index = offset + 1;
    const filename = `신청서-${index}.hwpx`;
    const body = Buffer.from(`source form ${index}`);
    const markdown = input.markdownBody?.(index) ?? `신청서 ${index} 전문`;
    return { index, filename, body, markdown };
  });
  const zipEntries = Object.fromEntries(members.map((member) => [member.filename, member.body]));
  if (input.nested) {
    zipEntries["nested.zip"] = Buffer.from(zipSync({ "nested.hwp": Buffer.from("nested") }));
  }
  const parentBody = Buffer.from(zipSync(zipEntries));
  const archives: LabInputArchive[] = [
    archive({
      id: "zip-parent",
      filename: "붙임파일.zip",
      sourceUri: parentUri,
      bytes: parentBody.byteLength,
      storageKey: "archive/붙임파일.zip",
      sha256: sha256(parentBody),
      conversionStatus: "skipped",
    }),
    ...members.map((member) => archive({
      id: `zip-child-${member.index}`,
      filename: member.filename,
      sourceUri: `zip:${parentUri}#${encodeURIComponent(member.filename)}`,
      bytes: member.body.byteLength,
      storageKey: `archive/${member.filename}`,
      sha256: sha256(member.body),
      conversionStatus: "converted",
      markdownStorageKey: `markdown/${member.filename}.md`,
      markdownSha256: sha256(member.markdown),
      markdownBytes: member.markdown.length,
    })),
  ];
  const textObjects = Object.fromEntries(members.map((member) => [
    `markdown/${member.filename}.md`,
    member.markdown,
  ]));
  let parentReads = 0;
  const storage: LabAttachmentTextStorage = {
    ...fakeStorage(textObjects),
    async getObjectBytes(key) {
      if (key !== "archive/붙임파일.zip") throw new Error(`no such key: ${key}`);
      parentReads += 1;
      return { body: parentBody, contentType: "application/zip" };
    },
  };
  return { archives, storage, textObjects, parentBody, parentReads: () => parentReads };
}

async function run() {
  // ⓪ archive 변환 포인터가 비어도 같은 원본의 검증된 surface markdown을 재사용한다.
  {
    const hydrated = applyLabVerifiedConversionArtifacts([
      archive({ filename: "공고문.pdf", storageKey: "archive/source.pdf" }),
    ], [{
      sourceAttachment: "archive/source.pdf",
      title: "공고문.pdf",
      storageKey: "converted/source.md",
      sha256: "a".repeat(64),
      markdownChars: 791,
    }]);
    assert.equal(hydrated[0]?.markdownStorageKey, "converted/source.md");
    assert.equal(hydrated[0]?.markdownSha256, "a".repeat(64));
    assert.equal(hydrated[0]?.markdownBytes, 791);
    assert.equal(hydrated[0]?.conversionStatus, "converted");

    const ambiguous = applyLabVerifiedConversionArtifacts([
      archive({ filename: "중복.pdf" }),
    ], [
      { sourceAttachment: null, title: "중복.pdf", storageKey: "a.md", sha256: "a".repeat(64) },
      { sourceAttachment: null, title: "중복.pdf", storageKey: "b.md", sha256: "b".repeat(64) },
    ]);
    assert.equal(ambiguous[0]?.markdownStorageKey, null, "이름만 같은 복수 artifact는 임의 연결하지 않는다");
  }

  // ① markdown 없는 첨부 → unavailable("변환 안 됨") + 고지문 + input_missing 유도 문구
  {
    const result = await assembleLabInput(
      {
        grant: GRANT,
        payload: null,
        archives: [
          archive({ filename: "참가신청서.hwp" }),
          archive({ filename: "공고문.txt", markdownStorageKey: "md/공고문", markdownBytes: 30 }),
        ],
      },
      { storage: fakeStorage({ "md/공고문": "공고 본문 텍스트입니다." }) },
    );
    const missing = result.blocks.find((b) => b.label.includes("참가신청서.hwp"));
    assert.ok(missing, "markdown 없는 첨부가 blocks 메타에 나타나야 한다");
    assert.equal(missing.label, "첨부 미투입(변환 안 됨): 참가신청서.hwp");
    assert.equal(missing.chars, 0);
    assert.equal(missing.truncated, true);
    assert.match(result.text, /\[입력 한계 고지\]/);
    assert.match(result.text, /참가신청서\.hwp\(변환 안 됨\)/);
    assert.match(result.text, /input_missing/);
    // markdown 있는 첨부는 기존대로 블록 포함
    assert.match(result.text, /첨부 공고문: 공고문\.txt/);
    assert.match(result.text, /공고 본문 텍스트입니다\./);
  }

  // ② 전 첨부가 markdown 미생성이어도 고지된다 (기존엔 빈 배열로 무고지)
  {
    const result = await assembleLabInput(
      { grant: GRANT, payload: null, archives: [archive({ filename: "양식.hwp" })] },
      { storage: fakeStorage({}) },
    );
    assert.match(result.text, /양식\.hwp\(변환 안 됨\)/);
  }

  // ③ R2 미설정(storage null) 분기 — markdown 없는 첨부는 "변환 안 됨", 있는 첨부는 "R2 미설정"
  {
    const result = await assembleLabInput(
      {
        grant: GRANT,
        payload: null,
        archives: [
          archive({ filename: "참가신청서.hwp" }),
          archive({ filename: "공고문.txt", markdownStorageKey: "md/공고문", markdownBytes: 30 }),
        ],
      },
      { storage: null },
    );
    assert.match(result.text, /참가신청서\.hwp\(변환 안 됨\)/);
    assert.match(result.text, /공고문\.txt\(R2 미설정\)/);
  }

  // ④ 캡 초과 기존 동작 무회귀 — 예산 소진 시 cap_exceeded 로 고지
  {
    process.env.ANALYSIS_LAB_INPUT_CHAR_CAP = "600";
    try {
      const long = "가".repeat(500);
      const result = await assembleLabInput(
        {
          grant: GRANT,
          payload: null,
          archives: [
            archive({ filename: "본문공고.txt", markdownStorageKey: "md/a", markdownBytes: 500 }),
            archive({ filename: "서식양식.txt", markdownStorageKey: "md/b", markdownBytes: 500 }),
          ],
        },
        { storage: fakeStorage({ "md/a": long, "md/b": long }) },
      );
      assert.match(result.text, /캡 초과 미로드|뒷부분 잘림|전체 제외/);
    } finally {
      delete process.env.ANALYSIS_LAB_INPUT_CHAR_CAP;
    }
  }

  // ⑤ 로드 실패는 기존대로 load_failed
  {
    const result = await assembleLabInput(
      {
        grant: GRANT,
        payload: null,
        archives: [archive({ filename: "공고문.txt", markdownStorageKey: "md/없는키", markdownBytes: 30 })],
      },
      { storage: fakeStorage({}) },
    );
    assert.match(result.text, /공고문\.txt\(로드 실패\)/);
  }

  // ⑥ 검증된 artifact 포인터는 저장 본문 SHA가 달라지면 입력에 쓰지 않는다.
  {
    const result = await assembleLabInput(
      {
        grant: GRANT,
        payload: null,
        archives: [archive({
          filename: "검증공고.pdf",
          markdownStorageKey: "md/검증공고",
          markdownSha256: "0".repeat(64),
          markdownBytes: 30,
        })],
      },
      { storage: fakeStorage({ "md/검증공고": "실제 본문" }) },
    );
    assert.match(result.text, /검증공고\.pdf\(로드 실패\)/);
    assert.doesNotMatch(result.text, /첨부 공고문: 검증공고\.pdf/);
  }

  // ⑦ 실제 입력 조립 provenance는 archive 입력 순서와 무관한 canonical manifest SHA로 고정된다.
  {
    process.env.ANALYSIS_LAB_INPUT_CHAR_CAP = "80";
    try {
      const mismatchedRaw = "---\nsource: mismatch\n---\n실제 다른 본문\n";
      const longRaw = `---\nsource: long\n---\n${"가".repeat(300)}\n`;
      const archives = [
        archive({
          filename: "a-mismatch.md",
          storageKey: "archive/a",
          markdownStorageKey: "md/a",
          markdownSha256: "0".repeat(64),
          markdownBytes: 1_000,
        }),
        archive({
          filename: "b-long.md",
          storageKey: "archive/b",
          markdownStorageKey: "md/b",
          markdownSha256: "76eb64b349983e29f4add18ce9e96c477e297555ea93d8a7f7de6c09974d8aad",
          markdownBytes: 999,
        }),
        archive({
          filename: "c-missing.hwp",
          storageKey: "archive/c",
        }),
      ];
      const storage = fakeStorage({
        "md/a": mismatchedRaw,
        "md/b": longRaw,
      });
      const forward = await assembleLabInput(
        { grant: GRANT, payload: null, archives },
        { storage },
      );
      const reversed = await assembleLabInput(
        { grant: GRANT, payload: null, archives: [...archives].reverse() },
        { storage },
      );

      assert.equal(
        forward.attachmentManifestSha256,
        "543b9c80c3b6855c839a2fc3760ba427e89f1b78a4dc7b67316f6bc438ed4664",
      );
      assert.equal(reversed.attachmentManifestSha256, forward.attachmentManifestSha256);
      assert.equal(
        reversed.inputSha256,
        forward.inputSha256,
        "입력 archive 순서가 바뀌어도 조립 결과가 같아야 한다",
      );
      assert.deepEqual(
        forward.blocks.find((block) => block.label === "첨부 공고문: b-long.md"),
        { label: "첨부 공고문: b-long.md", chars: 56, truncated: true },
      );
      assert.match(forward.text, /a-mismatch\.md\(로드 실패\)/);
      assert.match(forward.text, /c-missing\.hwp\(변환 안 됨\)/);
    } finally {
      delete process.env.ANALYSIS_LAB_INPUT_CHAR_CAP;
    }
  }

  // ⑧ seq25 형태: ZIP parent 실제 바이트와 5개 child 원본·전문이 모두 검증되어
  // 잘리지 않은 입력에 들어갔을 때만 parent의 중복 미변환 경고를 제거한다.
  {
    const fixture = zipCoverageFixture();
    const result = await assembleLabInput(
      { grant: GRANT, payload: null, archives: fixture.archives },
      { storage: fixture.storage },
    );
    assert.equal(
      result.blocks.filter((block) => block.label.startsWith("첨부 공고문: 신청서-")).length,
      5,
    );
    assert.doesNotMatch(result.text, /붙임파일\.zip\(변환 안 됨\)/);
    assert.equal(
      result.blocks.some((block) => block.label === "첨부 미투입(변환 안 됨): 붙임파일.zip"),
      false,
    );
    assert.equal(fixture.parentReads(), 1, "ZIP parent는 한 번만 읽어 coverage를 검사한다");

    const historical = await assembleLabInput(
      { grant: GRANT, payload: null, archives: fixture.archives },
      {
        storage: fixture.storage,
        preserveUnavailableArchiveFilenames: new Set(["붙임파일.zip"]),
      },
    );
    assert.match(historical.text, /붙임파일\.zip\(변환 안 됨\)/);
    assert.notEqual(historical.inputSha256, result.inputSha256);
    assert.notEqual(historical.attachmentManifestSha256, result.attachmentManifestSha256);
    const legacyStorage = fakeStorage(fixture.textObjects);
    const legacy = await assembleLabInput(
      { grant: GRANT, payload: null, archives: fixture.archives },
      { storage: legacyStorage },
    );
    assert.equal(
      historical.inputSha256,
      legacy.inputSha256,
      "과거 ZIP 미투입 고지를 보존하면 기존 input SHA가 그대로 재현되어야 한다",
    );
    assert.equal(
      historical.attachmentManifestSha256,
      legacy.attachmentManifestSha256,
      "과거 ZIP 미투입 provenance도 기존 attachment manifest SHA와 같아야 한다",
    );
  }

  // ⑨ ZIP member 하나가 inventory에서 빠지면 parent 경고를 유지한다.
  {
    const fixture = zipCoverageFixture();
    const result = await assembleLabInput(
      { grant: GRANT, payload: null, archives: fixture.archives.slice(0, -1) },
      { storage: fixture.storage },
    );
    assert.match(result.text, /붙임파일\.zip\(변환 안 됨\)/);
  }

  // ⑩ child 전문 load/SHA 검증이 실패하면 parent 경고와 child 실패를 함께 유지한다.
  {
    const fixture = zipCoverageFixture();
    const failedKey = fixture.archives[1]?.markdownStorageKey;
    assert.ok(failedKey);
    const storage: LabAttachmentTextStorage = {
      ...fixture.storage,
      async getObjectText(key) {
        if (key === failedKey) return "tampered markdown";
        const body = fixture.textObjects[key];
        if (body === undefined) throw new Error(`no such key: ${key}`);
        return body;
      },
    };
    const result = await assembleLabInput(
      { grant: GRANT, payload: null, archives: fixture.archives },
      { storage },
    );
    assert.match(result.text, /붙임파일\.zip\(변환 안 됨\)/);
    assert.match(result.text, /신청서-1\.hwpx\(로드 실패\)/);
  }

  // ⑪ child가 잘리거나 뒤 child를 cap 때문에 읽지 못하면 parent 경고를 유지한다.
  {
    const baseline = await assembleLabInput(
      { grant: GRANT, payload: null, archives: [] },
      { storage: fakeStorage({}) },
    );
    const fixture = zipCoverageFixture({ markdownBody: (index) => `${index}`.repeat(200) });
    process.env.ANALYSIS_LAB_INPUT_CHAR_CAP = String(baseline.blocks[0]!.chars + 20);
    try {
      const result = await assembleLabInput(
        { grant: GRANT, payload: null, archives: fixture.archives },
        { storage: fixture.storage },
      );
      assert.match(result.text, /붙임파일\.zip\(변환 안 됨\)/);
      assert.ok(
        result.blocks.some((block) => (
          block.label.startsWith("첨부 공고문: 신청서-") && block.truncated
        )),
        "첫 child 전문은 입력 cap에서 잘려야 한다",
      );
      assert.ok(
        result.blocks.some((block) => block.label.includes("첨부 미투입(캡 초과 미로드): 신청서-")),
        "뒤 child는 cap_exceeded로 남아야 한다",
      );
    } finally {
      delete process.env.ANALYSIS_LAB_INPUT_CHAR_CAP;
    }
  }

  // ⑫ 중첩 ZIP은 직접 입증하지 않으므로 일반 child가 모두 있어도 parent 경고를 유지한다.
  {
    const fixture = zipCoverageFixture({ nested: true });
    const result = await assembleLabInput(
      { grant: GRANT, payload: null, archives: fixture.archives },
      { storage: fixture.storage },
    );
    assert.match(result.text, /붙임파일\.zip\(변환 안 됨\)/);
  }

  // ⑬ archive 행의 markdown 포인터가 surface artifact로 복구된 child도 같은 검증을 거친다.
  {
    const fixture = zipCoverageFixture();
    const recoveredIndex = 1;
    const source = fixture.archives[recoveredIndex]!;
    const recovered = applyLabVerifiedConversionArtifacts(
      fixture.archives.map((item, index) => index === recoveredIndex
        ? {
            ...item,
            conversionStatus: null,
            markdownStorageKey: null,
            markdownSha256: null,
            markdownBytes: null,
          }
        : item),
      [{
        sourceAttachment: source.storageKey ?? null,
        title: source.filename,
        storageKey: source.markdownStorageKey!,
        sha256: source.markdownSha256!,
        markdownChars: source.markdownBytes,
      }],
    );
    assert.equal(recovered[recoveredIndex]?.conversionStatus, "converted");
    const result = await assembleLabInput(
      { grant: GRANT, payload: null, archives: recovered },
      { storage: fixture.storage },
    );
    assert.doesNotMatch(result.text, /붙임파일\.zip\(변환 안 됨\)/);
  }

  console.log("input.test.ts: 14개 시나리오 전부 통과");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

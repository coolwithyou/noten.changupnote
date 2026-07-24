// assembleLabInput 첨부 고지 단위 테스트 — R2 실호출 없이 storage 주입으로 검증.
// 핵심: markdown 미생성 첨부(변환 실패·미시도)가 조용히 사라지지 않고
// blocks 메타(첨부 미투입)와 모델 고지([입력 한계 고지])에 나타나야 한다(178352 실사례 회귀 방지).
import assert from "node:assert/strict";
import { assembleLabInput, type LabAttachmentTextStorage, type LabInputArchive } from "./input";

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

async function run() {
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

  console.log("input.test.ts: 5개 시나리오 전부 통과");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

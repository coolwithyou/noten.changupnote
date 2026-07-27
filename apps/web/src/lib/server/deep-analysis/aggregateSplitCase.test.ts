import assert from "node:assert/strict";

import type { DeepAnalysisInputSeal } from "./inputManifest";
import { detectAggregateSplitRequirement } from "./aggregateSplitCase";

const knownAggregateCase = detectAggregateSplitRequirement({
  title: "2026년 중앙부처 및 지자체 창업지원사업 통합공고",
  seal: fakeSeal({
    totalChars: 1_136_482,
    chunkCount: 22,
    blockedByCap: true,
  }),
  inputCapChars: 800_000,
});
assert.ok(knownAggregateCase);
assert.equal(knownAggregateCase.reasonCode, "oversized_aggregate_notice");
assert.equal(knownAggregateCase.inputChars, 1_136_482);
assert.equal(knownAggregateCase.chunkCount, 22);
assert.match(knownAggregateCase.evidenceSha256, /^[0-9a-f]{64}$/);

assert.equal(detectAggregateSplitRequirement({
  title: "2026년 단일 사업 상세 안내",
  seal: fakeSeal({
    totalChars: 1_136_482,
    chunkCount: 22,
    blockedByCap: true,
  }),
  inputCapChars: 800_000,
}), null, "긴 단일사업 공고는 자동으로 통합공고 케이스가 되지 않는다");

assert.equal(detectAggregateSplitRequirement({
  title: "2026년 창업지원사업 통합공고",
  seal: fakeSeal({
    totalChars: 700_000,
    chunkCount: 12,
    blockedByCap: false,
  }),
  inputCapChars: 800_000,
}), null, "상한 이내 통합공고는 일반 딥분석 경로를 유지한다");

const mixedBlockerSeal = fakeSeal({
  totalChars: 1_136_482,
  chunkCount: 22,
  blockedByCap: true,
});
mixedBlockerSeal.blockers.push({
  code: "blocked_conversion",
  attachmentId: "guidebook",
  message: "변환 미완료",
});
assert.equal(detectAggregateSplitRequirement({
  title: "2026년 창업지원사업 통합공고",
  seal: mixedBlockerSeal,
  inputCapChars: 800_000,
}), null, "원문 복구 blocker가 함께 있으면 먼저 입력 복구 경로에 남긴다");

console.log("aggregate split case detection tests passed");

function fakeSeal(input: {
  totalChars: number;
  chunkCount: number;
  blockedByCap: boolean;
}): DeepAnalysisInputSeal {
  return {
    schema: "deep-analysis-input-v1",
    grantId: "22222222-2222-4222-8222-222222222222",
    sourceRevisionSha256: "a".repeat(64),
    attachmentManifestSha256: "b".repeat(64),
    inputSha256: "c".repeat(64),
    sealed: !input.blockedByCap,
    attachments: [{
      id: "guidebook",
      filename: "통합공고 안내책자.pdf",
      sourceUri: "https://example.com/guidebook.pdf",
      contentType: "application/pdf",
      bytes: 1,
      storageKey: "archive/guidebook.pdf",
      sha256: "d".repeat(64),
      conversionStatus: "converted",
      markdownStorageKey: "markdown/guidebook.md",
      markdownSha256: "e".repeat(64),
      disposition: "included",
      dispositionReason: null,
      duplicateOf: null,
      textChars: input.totalChars,
      textSha256: "f".repeat(64),
      chunkIds: [],
    }],
    chunks: Array.from({ length: input.chunkCount }, (_, index) => ({
      id: `chunk-${index + 1}`,
      sourceKind: "attachment" as const,
      sourceId: "guidebook",
      index,
      startChar: index,
      endChar: index + 1,
      chars: 1,
      sha256: "0".repeat(64),
      text: "x",
    })),
    blockers: input.blockedByCap ? [{
      code: "blocked_cap",
      attachmentId: null,
      message: "입력 상한 초과",
    }] : [],
    totalChars: input.totalChars,
    inputArtifactBody: "{}\n",
  };
}

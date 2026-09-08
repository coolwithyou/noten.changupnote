import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
  CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
  canonicalConfirmationQuestionDraftJson,
  type ConfirmationQuestionDraftPacketBody,
  type ConfirmationQuestionDraftPacket,
} from "@cunote/contracts/confirmation-question-draft";
import {
  beginConfirmationQuestionDraftImport,
  buildManualConfirmationDraftInput,
  importConfirmationQuestionDraft,
  type EditableConfirmationQuestionDraftItem,
} from "./confirmation-question-draft";

function packet(): ConfirmationQuestionDraftPacket {
  const body: ConfirmationQuestionDraftPacketBody = {
    schema: CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
    generatorVersion: CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
    authority: {
      status: "unreviewed_draft" as const,
      modelCallsMade: 0 as const,
      serviceDatabaseWritesMade: 0 as const,
      releaseAuthorized: false as const,
      promotionAuthorized: false as const,
      liveQuestionWriteAuthorized: false as const,
      currentServiceStateVerified: false as const,
    },
    source: {
      grantId: "grant-1",
      runId: "run-2026-09-09T000000.000Z-acde12",
      source: "bizinfo",
      sourceId: "source-1",
      inputSha256: "a".repeat(64),
      sourceRevisionSha256: "b".repeat(64),
      attachmentManifestSha256: null,
      runArtifactSha256: "c".repeat(64),
      reviewArtifactSha256: "d".repeat(64),
      criterionReviewerEmail: "reviewer@example.invalid",
      reviewUpdatedAt: "2026-09-09T00:00:00.000Z",
    },
    items: [{
      criterionIndex: 0,
      criterionKind: "exclusion" as const,
      polarity: "exclusion_membership" as const,
      criterionSha256: "e".repeat(64),
      sourceSpan: "휴업 또는 폐업 중인 기업은 신청할 수 없다.",
      resolutionScope: "per_notice" as const,
      answerType: "single" as const,
      prompt: "다음 제외 조건에 해당하나요?",
      options: [
        { value: "yes" as const, label: "해당해요", evaluation: "unsatisfied" as const },
        { value: "no" as const, label: "해당하지 않아요", evaluation: "satisfied" as const },
        { value: "unknown" as const, label: "확인할 수 없어요", evaluation: "unknown" as const },
      ],
    }],
  };
  return {
    ...body,
    contentSha256: createHash("sha256").update(canonicalConfirmationQuestionDraftJson(body)).digest("hex"),
  };
}

test("packet import는 content/file SHA를 확인하고 편집 상태를 pending으로 연다", async () => {
  const text = `${JSON.stringify(packet(), null, 2)}\n`;
  const imported = await importConfirmationQuestionDraft(text);
  assert.equal(imported.items[0]?.decision, "pending");
  assert.equal(imported.questionAuthorEmail, "");
  assert.equal(imported.fileSha256, createHash("sha256").update(text).digest("hex"));

  const tampered = JSON.parse(text) as ConfirmationQuestionDraftPacket;
  tampered.items[0]!.sourceSpan = "변조";
  await assert.rejects(importConfirmationQuestionDraft(JSON.stringify(tampered)), /content SHA/);
});

test("bound export를 다시 가져오면 편집 문구·작성자와 include/exclude 결정을 복원한다", async () => {
  const draftPacket = packet();
  draftPacket.items.push({
    ...draftPacket.items[0]!,
    criterionIndex: 1,
    criterionSha256: "f".repeat(64),
    sourceSpan: "두 번째 후보",
    prompt: "두 번째 후보 질문",
    options: draftPacket.items[0]!.options.map((option) => ({ ...option })) as typeof draftPacket.items[0]["options"],
  });
  draftPacket.contentSha256 = createHash("sha256").update(canonicalConfirmationQuestionDraftJson({
    schema: draftPacket.schema,
    generatorVersion: draftPacket.generatorVersion,
    authority: draftPacket.authority,
    source: draftPacket.source,
    items: draftPacket.items,
  })).digest("hex");
  const editable: EditableConfirmationQuestionDraftItem = {
    ...draftPacket.items[0]!,
    prompt: "관리자가 편집한 질문",
    options: draftPacket.items[0]!.options.map((option) => ({ ...option })),
    decision: "include",
  };
  const envelope = buildManualConfirmationDraftInput({
    packet: draftPacket,
    questionAuthorEmail: "author@example.invalid",
    items: [editable],
  });
  const imported = await importConfirmationQuestionDraft(`${JSON.stringify(envelope, null, 2)}\n`);
  assert.equal(imported.questionAuthorEmail, "author@example.invalid");
  assert.equal(imported.items[0]?.prompt, "관리자가 편집한 질문");
  assert.equal(imported.items[0]?.decision, "include");
  assert.equal(imported.items[1]?.decision, "exclude");
});

test("import generation은 늦게 끝난 이전 파일이 최신 선택을 덮지 못하게 한다", () => {
  const generation = { current: 0 };
  const slowA = beginConfirmationQuestionDraftImport(generation);
  const fastB = beginConfirmationQuestionDraftImport(generation);
  assert.equal(slowA.isLatest(), false);
  assert.equal(fastB.isLatest(), true);
  assert.equal(fastB.value, 2);
});

test("모든 후보의 명시 결정과 별도 질문 작성자 이메일이 있어야 기존 manual CLI 입력을 만든다", () => {
  const item: EditableConfirmationQuestionDraftItem = {
    ...packet().items[0]!,
    options: packet().items[0]!.options.map((option) => ({ ...option })),
    decision: "include",
  };
  assert.deepEqual(buildManualConfirmationDraftInput({
    packet: packet(),
    questionAuthorEmail: " author@example.invalid ",
    items: [item, { ...item, criterionIndex: 1, decision: "exclude" }],
  }), {
    schema: "confirmation-question-manual-input-envelope-v1",
    draftPacket: packet(),
    manualInput: {
      questionAuthorEmail: "author@example.invalid",
      items: [{
        criterionIndex: 0,
        resolutionScope: "per_notice",
        prompt: item.prompt,
        options: item.options,
      }],
    },
  });
  assert.throws(() => buildManualConfirmationDraftInput({
    packet: packet(),
    questionAuthorEmail: "author@example.invalid",
    items: [{ ...item, decision: "pending" }],
  }), /명시 검토/);
});

test("화면 편집은 label만 허용하고 exclusion 평가 극성 변경은 내보내기에서 거부한다", () => {
  const item: EditableConfirmationQuestionDraftItem = {
    ...packet().items[0]!,
    options: packet().items[0]!.options.map((option) => ({ ...option })),
    decision: "include",
  };
  item.options[0]!.label = "예, 해당합니다";
  assert.equal(buildManualConfirmationDraftInput({
    packet: packet(),
    questionAuthorEmail: "author@example.invalid",
    items: [item],
  }).manualInput.items[0]!.options[0]!.evaluation, "unsatisfied");
  item.options[0]!.evaluation = "satisfied";
  assert.throws(() => buildManualConfirmationDraftInput({
    packet: packet(),
    questionAuthorEmail: "author@example.invalid",
    items: [item],
  }), /극성이 변경/);
});

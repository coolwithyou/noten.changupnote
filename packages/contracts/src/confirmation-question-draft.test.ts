import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
  CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
  CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
  canonicalConfirmationQuestionDraftJson,
  confirmationQuestionDraftPacketBody,
  parseConfirmationQuestionManualInputEnvelope,
  parseConfirmationQuestionDraftPacket,
  type ConfirmationQuestionDraftPacket,
} from "./confirmation-question-draft.js";

const sha = (character: string) => character.repeat(64);

function fixture(kind: "required" | "preferred" | "exclusion" = "required"):
ConfirmationQuestionDraftPacket {
  const exclusion = kind === "exclusion";
  return {
    schema: CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
    generatorVersion: CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
    authority: {
      status: "unreviewed_draft",
      modelCallsMade: 0,
      serviceDatabaseWritesMade: 0,
      releaseAuthorized: false,
      promotionAuthorized: false,
      liveQuestionWriteAuthorized: false,
      currentServiceStateVerified: false,
    },
    source: {
      grantId: "grant-1",
      runId: "20260909T000000Z-opus",
      source: "bizinfo",
      sourceId: "source-1",
      inputSha256: sha("1"),
      sourceRevisionSha256: sha("2"),
      attachmentManifestSha256: null,
      runArtifactSha256: sha("3"),
      reviewArtifactSha256: sha("4"),
      criterionReviewerEmail: "reviewer@example.com",
      reviewUpdatedAt: "2026-09-09T00:00:00.000Z",
    },
    items: [{
      criterionIndex: 1,
      criterionKind: kind,
      polarity: exclusion ? "exclusion_membership" : "criterion_satisfaction",
      criterionSha256: sha("5"),
      sourceSpan: "지원 대상 원문",
      resolutionScope: "per_notice",
      answerType: "single",
      prompt: exclusion ? "다음 제외 조건에 해당하나요?\n\n“지원 대상 원문”" : "다음 필수 조건을 충족하나요?\n\n“지원 대상 원문”",
      options: exclusion
        ? [
          { value: "yes", label: "해당해요", evaluation: "unsatisfied" },
          { value: "no", label: "해당하지 않아요", evaluation: "satisfied" },
          { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
        ]
        : [
          { value: "yes", label: "충족해요", evaluation: "satisfied" },
          { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" },
          { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
        ],
    }],
    contentSha256: sha("a"),
  };
}

test("required와 exclusion의 명시적 3상태 극성을 허용한다", () => {
  assert.equal(parseConfirmationQuestionDraftPacket(fixture()).items[0]?.polarity, "criterion_satisfaction");
  assert.equal(parseConfirmationQuestionDraftPacket(fixture("exclusion")).items[0]?.polarity, "exclusion_membership");
});

test("exclusion 문구와 무관하게 구조화된 평가 극성이 뒤집히면 거부한다", () => {
  const packet = fixture("exclusion");
  packet.items[0]!.prompt = "어떤 문구라도 극성의 근거가 아니다";
  packet.items[0]!.options[0]!.evaluation = "satisfied";
  assert.throws(() => parseConfirmationQuestionDraftPacket(packet), /평가 극성/);
});

test("authority를 승격 가능으로 바꾸거나 unknown 필드를 넣으면 fail-closed한다", () => {
  const authorityChanged = fixture() as unknown as Record<string, unknown>;
  (authorityChanged.authority as Record<string, unknown>).releaseAuthorized = true;
  assert.throws(() => parseConfirmationQuestionDraftPacket(authorityChanged), /무권한 offline 초안/);

  const extra = fixture() as unknown as Record<string, unknown>;
  extra.approved = true;
  assert.throws(() => parseConfirmationQuestionDraftPacket(extra), /필드가 계약과 정확히/);
});

test("canonical body는 content SHA를 제외하고 key 순서에 독립적이다", () => {
  const packet = fixture();
  const body = confirmationQuestionDraftPacketBody(packet);
  assert.equal("contentSha256" in body, false);
  assert.equal(
    canonicalConfirmationQuestionDraftJson({ b: 2, a: ["값", true] }),
    canonicalConfirmationQuestionDraftJson({ a: ["값", true], b: 2 }),
  );
});

test("bound manual input은 원 packet을 보존하고 packet 밖 index와 극성 변조를 거부한다", () => {
  const draftPacket = fixture("exclusion");
  const envelope = {
    schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
    draftPacket,
    manualInput: {
      questionAuthorEmail: "author@example.com",
      items: [{
        criterionIndex: 1,
        resolutionScope: "per_notice",
        prompt: "편집한 중립 질문",
        options: draftPacket.items[0]!.options,
      }],
    },
  };
  assert.deepEqual(parseConfirmationQuestionManualInputEnvelope(envelope).draftPacket, draftPacket);
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope,
    manualInput: {
      ...envelope.manualInput,
      items: [{ ...envelope.manualInput.items[0], criterionIndex: 9 }],
    },
  }), /draft packet에 없습니다/);
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope,
    manualInput: {
      ...envelope.manualInput,
      items: [{
        ...envelope.manualInput.items[0],
        options: envelope.manualInput.items[0]!.options.map((option, index) =>
          index === 0 ? { ...option, evaluation: "satisfied" } : option),
      }],
    },
  }), /평가 극성이 draft packet과 다릅니다/);

  assert.equal(
    (envelope as Record<string, unknown>).questionAuthorEmail,
    undefined,
    "schema 오타가 있어도 legacy manual input으로 해석 가능한 top-level 필드를 두지 않는다",
  );
});

test("회사 사실 범위는 검수자가 확정한 표준 키가 있어야만 bound 입력으로 받는다", () => {
  const draftPacket = fixture();
  draftPacket.items[0]!.normalizedCriterion = {
    dimension: "other", kind: "required", operator: "text_only",
    value: { fact_scope: "registered_business", basis_date: "2026-09-22" },
  };
  const item = {
    criterionIndex: draftPacket.items[0]!.criterionIndex,
    resolutionScope: "company_fact",
    conditionKey: "registered_business_location",
    companyFactReview: {
      meaning: "현재 등록된 사업장이 해당 지역에 있는지",
      definitionKey: "registered_business_location",
      definitionSource: "new_review",
      scopeField: "fact_scope",
      scopeValue: "registered_business",
      asOfField: "basis_date",
      asOfDate: "2026-09-22",
      reviewArtifactSha256: draftPacket.source.reviewArtifactSha256,
    },
    prompt: "사업장이 해당 지역에 있나요?",
    options: draftPacket.items[0]!.options,
  };
  const envelope = {
    schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
    draftPacket,
    manualInput: { questionAuthorEmail: "author@example.com", items: [item] },
  };
  assert.equal(parseConfirmationQuestionManualInputEnvelope(envelope).manualInput.items[0]?.conditionKey,
    "registered_business_location");
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope,
    manualInput: { ...envelope.manualInput, items: [{ ...item, conditionKey: "잘못된 키" }] },
  }), /표준 사실 키 형식/);
  const { conditionKey: _conditionKey, ...withoutKey } = item;
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope,
    manualInput: { ...envelope.manualInput, items: [withoutKey] },
  }), /필드가 계약과 정확히 일치/);
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope,
    manualInput: { ...envelope.manualInput, items: [{
      ...item,
      companyFactReview: { ...item.companyFactReview, asOfDate: "2026-10-01" },
    }] },
  }), /검수 근거·scope·기준일/);
  const noteOnly = fixture();
  noteOnly.items[0]!.normalizedCriterion = {
    dimension: "other", kind: "required", operator: "text_only",
    value: { note: "2026-09-22 기준 등록 사업장" },
  };
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope, draftPacket: noteOnly,
  }), /정규화 scope\/기준일이 없어/);
  const noteWithStructuredFields = fixture();
  noteWithStructuredFields.items[0]!.normalizedCriterion = {
    dimension: "other", kind: "required", operator: "text_only",
    value: { fact_scope: "registered_business", basis_date: "2026-09-22", note: "본점만 해당" },
  };
  assert.throws(() => parseConfirmationQuestionManualInputEnvelope({
    ...envelope, draftPacket: noteWithStructuredFields,
  }), /정규화 scope\/기준일이 없어/);
});

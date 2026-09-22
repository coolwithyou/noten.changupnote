import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
  LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
  canonicalLegacyQuestionMigrationReviewJson,
  type LegacyQuestionMigrationReviewManifest,
  type LegacyQuestionMigrationReviewManifestBody,
  type LegacyQuestionMigrationReviewPacket,
  type LegacyQuestionMigrationReviewPacketBody,
} from "@cunote/contracts/legacy-question-migration-review"
import {
  beginLegacyQuestionMigrationReviewImport,
  buildLegacyQuestionMigrationReviewDecisionSet,
  importLegacyQuestionMigrationReviewFiles,
  restoreLegacyQuestionMigrationReviewProgress,
  serializeLegacyQuestionMigrationReviewProgress,
} from "./legacy-question-migration-review"

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function fixture(): {
  packet: LegacyQuestionMigrationReviewPacket
  manifest: LegacyQuestionMigrationReviewManifest
  packetFileName: string
} {
  const candidateSha256 = "a".repeat(64)
  const packetBody: LegacyQuestionMigrationReviewPacketBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
    authority: {
      status: "human_review_required",
      modelCallsMade: 0,
      serviceDatabaseWritesMade: 0,
      migrationAuthorized: false,
      releaseAuthorized: false,
      liveQuestionWriteAuthorized: false,
    },
    shadow: {
      schema: "legacy-question-migration-shadow-v1",
      snapshotSha256: "b".repeat(64),
      observedAt: "2026-09-22T00:00:00.000Z",
    },
    candidateSha256,
    grant: {
      id: "grant-1",
      title: "테스트 공고",
      source: "bizinfo",
      sourceId: "source-1",
      url: "https://example.com/grant-1",
      applyStart: "2026-09-01T00:00:00.000Z",
      applyEnd: "2026-09-30T00:00:00.000Z",
    },
    currentSource: {
      sourceRevisionSha256: "c".repeat(64),
      sourceRawSha256: "d".repeat(64),
    },
    legacyQuestion: {
      id: "question-1",
      grantId: "grant-1",
      criterionId: "criterion-1",
      evaluationContractVersion: null,
      sourceRevisionSha256: null,
      sourceRawSha256: null,
      criterionStableKey: null,
      definitionSha256: "legacy-definition",
      version: 1,
      prompt: "일반기업에 해당하나요?",
      options: [{ value: "yes", label: "예" }, { value: "no", label: "아니요" }],
      answerType: "single",
      reusable: "company_fact",
      conditionKey: "company_type",
      promptVersion: "legacy-v1",
      provenance: { source: "legacy" },
      createdAt: "2026-08-01T00:00:00.000Z",
      answerCount: 0,
      answeringCompanyCount: 0,
    },
    criterion: {
      id: "criterion-1",
      stableKey: null,
      dimension: "industry",
      kind: "exclusion",
      operator: "in",
      value: { values: ["소비재업"] },
      confidence: 0.9,
      sourceSpan: "소비재업 분야 중소기업은 제외",
      sourceField: "eligibility",
      needsReview: false,
      parserVersion: null,
    },
    requiredReview: {
      allowedVerdicts: ["approve_for_v2_draft", "repair_criterion", "retire_legacy_question"],
      expectedPolarity: "exclusion_membership",
      allowedResolutionScopes: ["per_notice", "company_fact"],
      checks: ["원문 조건 확인"],
      decisionTemplate: {
        schema: "legacy-question-migration-review-decision-v1",
        packetContentSha256: null,
        candidateSha256,
        grantId: "grant-1",
        questionId: "question-1",
        criterionId: "criterion-1",
        verdict: null,
        confirmedPolarity: null,
        resolutionScope: null,
        reviewerEmail: null,
        reviewedAt: null,
        note: null,
      },
    },
  }
  const packet = {
    ...packetBody,
    contentSha256: sha256(canonicalLegacyQuestionMigrationReviewJson(packetBody)),
  }
  const packetFileName = `${packet.legacyQuestion.id}.${packet.contentSha256}.json`
  const manifestBody: LegacyQuestionMigrationReviewManifestBody = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
    authority: packet.authority,
    shadow: packet.shadow,
    packetCount: 1,
    answerPreservationReviewCount: 0,
    packets: [{
      grantId: packet.grant.id,
      questionId: packet.legacyQuestion.id,
      criterionId: packet.criterion.id,
      candidateSha256: packet.candidateSha256,
      packetContentSha256: packet.contentSha256,
      fileName: packetFileName,
    }],
  }
  return {
    packet,
    packetFileName,
    manifest: {
      ...manifestBody,
      contentSha256: sha256(canonicalLegacyQuestionMigrationReviewJson(manifestBody)),
    },
  }
}

test("manifest와 exact packet 묶음을 검증해 pending 검수 항목으로 연다", async () => {
  const { manifest, packet, packetFileName } = fixture()
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const imported = await importLegacyQuestionMigrationReviewFiles([
    { name: `${manifest.contentSha256}.manifest.json`, text: manifestText },
    { name: packetFileName, text: `${JSON.stringify(packet, null, 2)}\n` },
  ])
  assert.equal(imported.items.length, 1)
  assert.equal(imported.items[0]?.verdict, "pending")
  assert.equal(imported.manifestFileSha256, sha256(manifestText))
})

test("packet 누락, 추가 파일, 내용 변조를 fail-closed 한다", async () => {
  const { manifest, packet, packetFileName } = fixture()
  const manifestFile = { name: "review.manifest.json", text: JSON.stringify(manifest) }
  await assert.rejects(importLegacyQuestionMigrationReviewFiles([manifestFile]), /모두 선택/)
  await assert.rejects(importLegacyQuestionMigrationReviewFiles([
    manifestFile,
    { name: packetFileName, text: JSON.stringify(packet) },
    { name: "unknown.json", text: JSON.stringify({ schema: "other" }) },
  ]), /지원하지 않는/)
  await assert.rejects(importLegacyQuestionMigrationReviewFiles([
    manifestFile,
    { name: packetFileName, text: JSON.stringify({ ...packet, grant: { ...packet.grant, title: "변조" } }) },
  ]), /packet content SHA/)
})

test("승인은 극성과 해소 범위를 명시해야 쓰기 권한 없는 decision set을 만든다", async () => {
  const { manifest, packet, packetFileName } = fixture()
  const imported = await importLegacyQuestionMigrationReviewFiles([
    { name: "review.manifest.json", text: JSON.stringify(manifest) },
    { name: packetFileName, text: JSON.stringify(packet) },
  ])
  const approved = [{
    ...imported.items[0]!,
    verdict: "approve_for_v2_draft" as const,
    polarityConfirmed: true,
    resolutionScope: "company_fact" as const,
    note: "원문과 극성 확인",
  }]
  const decisionSet = await buildLegacyQuestionMigrationReviewDecisionSet({
    manifest,
    reviewerEmail: " Human.Reviewer@Example.invalid ",
    reviewedAt: "2026-09-22T01:00:00.000Z",
    items: approved,
  })
  assert.equal(decisionSet.authority.migrationAuthorized, false)
  assert.equal(decisionSet.authority.liveQuestionWriteAuthorized, false)
  assert.equal(decisionSet.decisions[0]?.confirmedPolarity, "exclusion_membership")
  assert.equal(decisionSet.decisions[0]?.resolutionScope, "company_fact")
  assert.equal(decisionSet.decisions[0]?.reviewerEmail, "human.reviewer@example.invalid")

  await assert.rejects(buildLegacyQuestionMigrationReviewDecisionSet({
    manifest,
    reviewerEmail: "human@example.invalid",
    reviewedAt: "2026-09-22T01:00:00.000Z",
    items: [{ ...approved[0]!, polarityConfirmed: false }],
  }), /평가 극성/)
})

test("전체 explicit verdict와 사람 검수자 이메일이 필요하다", async () => {
  const { manifest, packet, packetFileName } = fixture()
  const imported = await importLegacyQuestionMigrationReviewFiles([
    { name: "review.manifest.json", text: JSON.stringify(manifest) },
    { name: packetFileName, text: JSON.stringify(packet) },
  ])
  await assert.rejects(buildLegacyQuestionMigrationReviewDecisionSet({
    manifest,
    reviewerEmail: "reviewer@example.invalid",
    reviewedAt: "2026-09-22T01:00:00.000Z",
    items: imported.items,
  }), /verdict/)
  await assert.rejects(buildLegacyQuestionMigrationReviewDecisionSet({
    manifest,
    reviewerEmail: "codex.bot@example.invalid",
    reviewedAt: "2026-09-22T01:00:00.000Z",
    items: [{ ...imported.items[0]!, verdict: "repair_criterion", note: "조건 구조 확인 필요" }],
  }), /사람 검수자/)
})

test("import generation은 이전 대량 파일 읽기가 최신 선택을 덮지 못하게 한다", () => {
  const generation = { current: 0 }
  const slow = beginLegacyQuestionMigrationReviewImport(generation)
  const latest = beginLegacyQuestionMigrationReviewImport(generation)
  assert.equal(slow.isLatest(), false)
  assert.equal(latest.isLatest(), true)
})

test("같은 manifest의 검수 진행만 로컬 저장에서 복원한다", async () => {
  const { manifest, packet, packetFileName } = fixture()
  const imported = await importLegacyQuestionMigrationReviewFiles([
    { name: "review.manifest.json", text: JSON.stringify(manifest) },
    { name: packetFileName, text: JSON.stringify(packet) },
  ])
  const review = {
    ...imported,
    items: [{
      ...imported.items[0]!,
      verdict: "approve_for_v2_draft" as const,
      polarityConfirmed: true,
      resolutionScope: "company_fact" as const,
      note: "검수 중 메모",
    }],
  }
  const raw = serializeLegacyQuestionMigrationReviewProgress({
    review,
    reviewerEmail: "human@example.com",
    activeIndex: 0,
  })
  const restored = restoreLegacyQuestionMigrationReviewProgress({ review: imported, raw })
  assert.equal(restored.reviewerEmail, "human@example.com")
  assert.equal(restored.review.items[0]?.verdict, "approve_for_v2_draft")
  assert.equal(restored.review.items[0]?.note, "검수 중 메모")
  assert.throws(() => restoreLegacyQuestionMigrationReviewProgress({
    review: imported,
    raw: raw.replace(manifest.contentSha256, "0".repeat(64)),
  }), /현재 manifest와 다릅니다/)
})

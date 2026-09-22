import {
  LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
  LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA,
  LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA,
  LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA,
  canonicalLegacyQuestionMigrationReviewJson,
  legacyQuestionMigrationReviewDecisionSetBody,
  legacyQuestionMigrationReviewManifestBody,
  legacyQuestionMigrationReviewPacketBody,
  parseLegacyQuestionMigrationReviewDecisionSet,
  parseLegacyQuestionMigrationReviewManifest,
  parseLegacyQuestionMigrationReviewPacket,
  type LegacyQuestionMigrationResolutionScope,
  type LegacyQuestionMigrationReviewDecisionSet,
  type LegacyQuestionMigrationReviewManifest,
  type LegacyQuestionMigrationReviewPacket,
  type LegacyQuestionMigrationReviewVerdict,
} from "@cunote/contracts/legacy-question-migration-review"

export type LegacyQuestionMigrationEditorVerdict =
  | "pending"
  | LegacyQuestionMigrationReviewVerdict

export interface EditableLegacyQuestionMigrationReviewItem {
  packet: LegacyQuestionMigrationReviewPacket
  verdict: LegacyQuestionMigrationEditorVerdict
  polarityConfirmed: boolean
  resolutionScope: LegacyQuestionMigrationResolutionScope | null
  note: string
}

export interface ImportedLegacyQuestionMigrationReview {
  manifest: LegacyQuestionMigrationReviewManifest
  manifestFileSha256: string
  items: EditableLegacyQuestionMigrationReviewItem[]
}

export interface LegacyQuestionMigrationReviewImportGeneration {
  current: number
}

export interface LegacyQuestionMigrationReviewTextFile {
  readonly name: string
  readonly text: string
}

export function beginLegacyQuestionMigrationReviewImport(
  generation: LegacyQuestionMigrationReviewImportGeneration,
): { value: number; isLatest: () => boolean } {
  const value = generation.current + 1
  generation.current = value
  return { value, isLatest: () => generation.current === value }
}

export async function importLegacyQuestionMigrationReviewFiles(
  files: readonly LegacyQuestionMigrationReviewTextFile[],
): Promise<ImportedLegacyQuestionMigrationReview> {
  if (files.length === 0) throw new Error("manifest와 packet JSON 파일을 선택해주세요.")
  const uniqueFiles = new Map<string, LegacyQuestionMigrationReviewTextFile>()
  for (const file of files) {
    if (uniqueFiles.has(file.name)) throw new Error(`같은 이름의 파일이 중복됐습니다: ${file.name}`)
    uniqueFiles.set(file.name, file)
  }

  let manifestFile: LegacyQuestionMigrationReviewTextFile | null = null
  let manifest: LegacyQuestionMigrationReviewManifest | null = null
  const packetsByFileName = new Map<string, LegacyQuestionMigrationReviewPacket>()
  for (const file of uniqueFiles.values()) {
    let raw: unknown
    try {
      raw = JSON.parse(file.text) as unknown
    } catch {
      throw new Error(`JSON을 읽을 수 없습니다: ${file.name}`)
    }
    const schema = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).schema
      : null
    if (schema === LEGACY_QUESTION_MIGRATION_REVIEW_MANIFEST_SCHEMA) {
      if (manifest) throw new Error("manifest 파일은 정확히 하나만 선택할 수 있습니다.")
      manifest = parseLegacyQuestionMigrationReviewManifest(raw)
      manifestFile = file
    } else if (schema === LEGACY_QUESTION_MIGRATION_REVIEW_PACKET_SCHEMA) {
      packetsByFileName.set(file.name, parseLegacyQuestionMigrationReviewPacket(raw))
    } else {
      throw new Error(`지원하지 않는 이관 검수 파일입니다: ${file.name}`)
    }
  }
  if (!manifest || !manifestFile) throw new Error("이관 검수 manifest 파일이 필요합니다.")

  await assertHash(
    manifest.contentSha256,
    canonicalLegacyQuestionMigrationReviewJson(legacyQuestionMigrationReviewManifestBody(manifest)),
    "manifest content SHA가 내용과 일치하지 않습니다.",
  )
  if (packetsByFileName.size !== manifest.packetCount) {
    throw new Error(`manifest가 요구하는 packet ${manifest.packetCount}건을 모두 선택해주세요.`)
  }

  const items: EditableLegacyQuestionMigrationReviewItem[] = []
  for (const entry of manifest.packets) {
    if (entry.fileName !== `${entry.questionId}.${entry.packetContentSha256}.json`) {
      throw new Error(`manifest packet 파일명이 content address와 다릅니다: ${entry.fileName}`)
    }
    const packet = packetsByFileName.get(entry.fileName)
    if (!packet) throw new Error(`manifest packet 파일이 누락됐습니다: ${entry.fileName}`)
    await assertHash(
      packet.contentSha256,
      canonicalLegacyQuestionMigrationReviewJson(legacyQuestionMigrationReviewPacketBody(packet)),
      `packet content SHA가 내용과 일치하지 않습니다: ${entry.fileName}`,
    )
    if (
      packet.contentSha256 !== entry.packetContentSha256
      || packet.candidateSha256 !== entry.candidateSha256
      || packet.grant.id !== entry.grantId
      || packet.legacyQuestion.grantId !== entry.grantId
      || packet.legacyQuestion.id !== entry.questionId
      || packet.legacyQuestion.criterionId !== entry.criterionId
      || packet.criterion.id !== entry.criterionId
      || packet.shadow.snapshotSha256 !== manifest.shadow.snapshotSha256
      || packet.shadow.observedAt !== manifest.shadow.observedAt
    ) {
      throw new Error(`manifest와 packet의 exact binding이 다릅니다: ${entry.fileName}`)
    }
    const template = packet.requiredReview.decisionTemplate
    if (
      template.candidateSha256 !== packet.candidateSha256
      || template.grantId !== packet.grant.id
      || template.questionId !== packet.legacyQuestion.id
      || template.criterionId !== packet.criterion.id
    ) {
      throw new Error(`packet decision template 결속이 다릅니다: ${entry.fileName}`)
    }
    packetsByFileName.delete(entry.fileName)
    items.push({
      packet,
      verdict: "pending",
      polarityConfirmed: false,
      resolutionScope: null,
      note: "",
    })
  }
  if (packetsByFileName.size !== 0) {
    throw new Error(`manifest에 없는 packet 파일이 섞였습니다: ${[...packetsByFileName.keys()][0]}`)
  }
  return {
    manifest,
    manifestFileSha256: await browserSha256(manifestFile.text),
    items,
  }
}

export async function buildLegacyQuestionMigrationReviewDecisionSet(input: {
  readonly manifest: LegacyQuestionMigrationReviewManifest
  readonly reviewerEmail: string
  readonly reviewedAt: string
  readonly items: readonly EditableLegacyQuestionMigrationReviewItem[]
}): Promise<LegacyQuestionMigrationReviewDecisionSet> {
  const reviewerEmail = validateHumanReviewerEmail(input.reviewerEmail)
  if (new Date(input.reviewedAt).toISOString() !== input.reviewedAt) {
    throw new Error("검수 시각이 canonical ISO 형식이 아닙니다.")
  }
  await assertHash(
    input.manifest.contentSha256,
    canonicalLegacyQuestionMigrationReviewJson(legacyQuestionMigrationReviewManifestBody(input.manifest)),
    "manifest content SHA가 내용과 일치하지 않습니다.",
  )
  if (input.items.length !== input.manifest.packetCount) {
    throw new Error("manifest의 모든 packet을 검수해야 합니다.")
  }
  const itemByQuestionId = new Map(input.items.map((item) => [item.packet.legacyQuestion.id, item]))
  if (itemByQuestionId.size !== input.items.length) throw new Error("검수 항목 questionId가 중복됐습니다.")

  const decisions = await Promise.all(input.manifest.packets.map(async (entry) => {
    const item = itemByQuestionId.get(entry.questionId)
    if (!item || item.packet.contentSha256 !== entry.packetContentSha256) {
      throw new Error(`manifest에 결속된 검수 항목이 없습니다: ${entry.questionId}`)
    }
    await assertHash(
      item.packet.contentSha256,
      canonicalLegacyQuestionMigrationReviewJson(legacyQuestionMigrationReviewPacketBody(item.packet)),
      `검수 항목 packet content SHA가 내용과 일치하지 않습니다: ${entry.questionId}`,
    )
    if (item.verdict === "pending") throw new Error("모든 packet의 verdict를 명시해주세요.")
    let confirmedPolarity = null
    let resolutionScope = null
    if (item.verdict === "approve_for_v2_draft") {
      if (!item.polarityConfirmed) throw new Error("승인 항목의 평가 극성을 명시 확인해주세요.")
      if (!item.resolutionScope) throw new Error("승인 항목의 질문 해소 범위를 선택해주세요.")
      confirmedPolarity = item.packet.requiredReview.expectedPolarity
      resolutionScope = item.resolutionScope
    } else if (!item.note.trim()) {
      throw new Error("조건 수리·기존 질문 폐기에는 후속 작업을 알 수 있는 검수 메모가 필요합니다.")
    }
    return {
      schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SCHEMA,
      packetContentSha256: item.packet.contentSha256,
      candidateSha256: item.packet.candidateSha256,
      grantId: item.packet.grant.id,
      questionId: item.packet.legacyQuestion.id,
      criterionId: item.packet.criterion.id,
      verdict: item.verdict,
      confirmedPolarity,
      resolutionScope,
      reviewerEmail,
      reviewedAt: input.reviewedAt,
      note: item.note.trim() || null,
    }
  }))
  const body = {
    schema: LEGACY_QUESTION_MIGRATION_REVIEW_DECISION_SET_SCHEMA,
    authority: {
      status: "human_review_record_only" as const,
      serviceDatabaseWritesMade: 0 as const,
      migrationAuthorized: false as const,
      releaseAuthorized: false as const,
      liveQuestionWriteAuthorized: false as const,
    },
    manifestContentSha256: input.manifest.contentSha256,
    shadowSnapshotSha256: input.manifest.shadow.snapshotSha256,
    createdAt: input.reviewedAt,
    decisions,
  }
  const set = parseLegacyQuestionMigrationReviewDecisionSet({
    ...body,
    contentSha256: await browserSha256(canonicalLegacyQuestionMigrationReviewJson(body)),
  })
  await assertHash(
    set.contentSha256,
    canonicalLegacyQuestionMigrationReviewJson(legacyQuestionMigrationReviewDecisionSetBody(set)),
    "decision set content SHA가 내용과 일치하지 않습니다.",
  )
  return set
}

export function legacyQuestionMigrationDecisionSetFilename(
  manifest: LegacyQuestionMigrationReviewManifest,
): string {
  return `${manifest.shadow.snapshotSha256}.${manifest.contentSha256}.human-decisions.json`
}

async function assertHash(expected: string, canonicalBody: string, message: string): Promise<void> {
  if (await browserSha256(canonicalBody) !== expected) throw new Error(message)
}

async function browserSha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function validateHumanReviewerEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("검수자 이메일 형식이 올바르지 않습니다.")
  }
  const local = email.split("@", 1)[0] ?? ""
  if (/(^|[._+-])(ai|bot|claude|codex|gemini|gpt|grok|llm)([._+-]|$)/i.test(local)) {
    throw new Error("사람 검수자의 이메일을 입력해주세요.")
  }
  return email
}

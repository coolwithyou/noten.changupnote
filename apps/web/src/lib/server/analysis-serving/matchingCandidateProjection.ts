import type { MatchingEvidence, NormalizedGrant } from "@cunote/contracts";

export interface MatchingServingEvidenceRow {
  grantId: string;
  appliedAt: Date | null;
  sourceRevisionSha256: string | null;
}

export interface CurrentMatchingSourceBinding {
  sourceRevisionSha256: string;
}

export function projectMatchingCandidates<TPayload>(input: {
  entries: Array<NormalizedGrant<TPayload>>;
  servingEvidence: MatchingServingEvidenceRow[];
  currentSources: ReadonlyMap<string, CurrentMatchingSourceBinding>;
}): Array<NormalizedGrant<TPayload>> {
  const latest = new Map<string, MatchingServingEvidenceRow>();
  for (const row of [...input.servingEvidence].sort(
    (left, right) => (right.appliedAt?.getTime() ?? 0) - (left.appliedAt?.getTime() ?? 0),
  )) {
    if (!latest.has(row.grantId)) latest.set(row.grantId, row);
  }
  return input.entries.map((entry) => {
    const grantId = entry.grant.id;
    const current = grantId ? input.currentSources.get(grantId) : undefined;
    const serving = grantId ? latest.get(grantId) : undefined;
    if (serving?.sourceRevisionSha256 && current
      && serving.sourceRevisionSha256 === current.sourceRevisionSha256) {
      return projectMatchingCandidate(entry, {
        level: "verified",
        sourceRevisionSha256: current.sourceRevisionSha256,
      });
    }
    return projectMatchingCandidate(entry, {
      level: "discovery",
      sourceRevisionSha256: current?.sourceRevisionSha256 ?? null,
      reason: !current || (serving && !serving.sourceRevisionSha256)
        ? "evidence_unavailable"
        : serving
          ? "source_changed"
          : "unreviewed",
    });
  });
}

/**
 * 사용자 매칭의 단일 안전 projection.
 * discovery는 원천에서 확인 가능한 식별·기관·기간·원문 링크만 보존한다.
 */
export function projectMatchingCandidate<TPayload>(
  entry: NormalizedGrant<TPayload>,
  evidence: MatchingEvidence,
): NormalizedGrant<TPayload> {
  if (evidence.level === "verified") return { ...entry, matching_evidence: evidence };
  const {
    extraction_manifest: _extractionManifest,
    matching_evidence: _matchingEvidence,
    ...baseEntry
  } = entry;
  const { attachments: _attachments, ...baseRaw } = entry.raw;
  const {
    apply_method: _applyMethod,
    audience: _audience,
    parser_version: _parserVersion,
    ...baseGrant
  } = entry.grant;
  return {
    ...baseEntry,
    matching_evidence: evidence,
    raw: { ...baseRaw, payload: {} as TPayload, attachments: null },
    criteria: [],
    authoring_readiness: {
      status: "unverified",
      sourceDisposition: "unverified",
    },
    grant: {
      ...baseGrant,
      support_amount: null,
      required_documents: null,
      benefits: null,
      obligations: null,
      f_regions: [],
      f_industries: [],
      f_biz_age_min_months: null,
      f_biz_age_max_months: null,
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      f_apply_methods: [],
      f_authoring_mode: "unknown",
      overall_confidence: 0,
      model_ver: null,
      prompt_ver: null,
    },
  };
}

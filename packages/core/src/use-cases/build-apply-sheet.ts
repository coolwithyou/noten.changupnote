import type { ApplySheet, MatchCard, NormalizedGrant } from "@cunote/contracts";
import {
  normalizeRequiredDocuments,
  normalizeSupportAmount,
  toRuleTraceChip,
  grantKey,
  daysUntil,
} from "./match-card.js";
import type { MatchedGrant } from "./match-card.js";

export interface BuildApplySheetOptions<TPayload = unknown> {
  entry: MatchedGrant<TPayload>;
  asOf?: Date;
}

export function buildApplySheet<TPayload>({
  entry,
  asOf = new Date(),
}: BuildApplySheetOptions<TPayload>): ApplySheet {
  const { grant } = entry.item as NormalizedGrant<TPayload>;
  const chips = entry.match.rule_trace.map(toRuleTraceChip);
  const textOnlyDocuments = chips
    .filter((chip) => chip.result === "text_only")
    .map((chip) => {
      const document = {
        name: chip.label,
        required: chip.kind === "required",
        source: "portal" as const,
        fromTextOnly: true,
      };
      return chip.sourceSpan ? { ...document, sourceSpan: chip.sourceSpan } : document;
    });

  return {
    grant: {
      id: grantKey(grant),
      source: grant.source,
      sourceId: grant.source_id,
      title: grant.title,
      agency: grant.agency_operator ?? grant.agency_jurisdiction ?? null,
      supportAmount: normalizeSupportAmount(grant.support_amount),
      status: grant.status,
    },
    satisfied: chips.filter((chip) => chip.checklistSection === "satisfied"),
    needsCheck: chips.filter((chip) => chip.checklistSection === "needs_check"),
    documents: [...normalizeRequiredDocuments(grant), ...textOnlyDocuments],
    applyMethod: summarizeApplyMethod(grant.apply_method),
    deepLink: grant.url ?? null,
    schedule: {
      applyStart: grant.apply_start ?? null,
      applyEnd: grant.apply_end ?? null,
      dDay: daysUntil(grant.apply_end ?? null, asOf),
    },
  };
}

function summarizeApplyMethod(value: Record<string, string | null> | undefined): string | null {
  if (!value) return null;
  const enabled = Object.entries(value)
    .filter(([, method]) => Boolean(method))
    .map(([key, method]) => method ?? key);
  if (enabled.length === 0) return null;
  return enabled.join(" · ");
}

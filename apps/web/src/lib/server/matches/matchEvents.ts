import type { MatchEventKind, MatchEventReceipt, MatchEventRequest, MatchEventResult } from "@cunote/contracts";
import type { SaveMatchEventInput } from "@cunote/core";

const MATCH_EVENTS: MatchEventKind[] = ["surfaced", "clicked", "saved", "apply_click"];

export async function readMatchEventRequest(request: Request): Promise<MatchEventRequest> {
  try {
    const parsed = await request.json() as MatchEventRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function buildSaveMatchEventInput(input: {
  companyId: string;
  grantId: string;
  body: MatchEventRequest;
  userId?: string;
}): SaveMatchEventInput {
  const event = normalizeMatchEvent(input.body.event ?? input.body.type);
  const eventInput: SaveMatchEventInput = {
    companyId: input.companyId,
    grantId: input.grantId,
    event,
  };
  if (input.userId) eventInput.userId = input.userId;
  if (input.body.rulesetVer) eventInput.rulesetVer = input.body.rulesetVer;
  return eventInput;
}

export function buildMatchEventResult(input: {
  event: SaveMatchEventInput;
  receipt: MatchEventReceipt;
}): MatchEventResult {
  return {
    accepted: true,
    companyId: input.event.companyId,
    grantId: input.event.grantId,
    event: input.event.event,
    receipt: input.receipt,
  };
}

export function decodeGrantIdSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeMatchEvent(value: unknown): MatchEventKind {
  return MATCH_EVENTS.includes(value as MatchEventKind) ? value as MatchEventKind : "clicked";
}

import type { MatchJourneyEvent, MatchEventKind, MatchEventReceipt, MatchEventRequest, MatchEventResult } from "@cunote/contracts";
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
  if (input.body.journey !== undefined) eventInput.journey = parseMatchJourney(input.body.journey);
  if (input.userId) eventInput.userId = input.userId;
  if (typeof input.body.rulesetVer === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(input.body.rulesetVer)) eventInput.rulesetVer = input.body.rulesetVer;
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

/** 서버에서 허용된 필드만 재구성한다. 자유 문자열/원문 답변은 보존하지 않는다. */
export function parseMatchJourney(value: unknown): MatchJourneyEvent {
  const reject = () => Object.assign(new Error("매칭 행동 정보를 확인해주세요."), { status: 400, code: "invalid_match_journey" });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reject();
  const input = value as Record<string, unknown>;
  const actions: MatchJourneyEvent["action"][] = ["card_open", "profile_start", "confirmation_start", "detail_open", "preparation_start"];
  if (input.version !== 1 || typeof input.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)
    || !actions.includes(input.action as MatchJourneyEvent["action"])
    || typeof input.elapsedMs !== "number" || !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0 || input.elapsedMs > 86_400_000
    || !["verified", "discovery", "legacy"].includes(input.evidence as string)
    || !["eligible", "conditional", "ineligible"].includes(input.eligibility as string)) throw reject();
  return { version: 1, sessionId: input.sessionId, action: input.action as MatchJourneyEvent["action"],
    elapsedMs: input.elapsedMs, evidence: input.evidence as MatchJourneyEvent["evidence"], eligibility: input.eligibility as MatchJourneyEvent["eligibility"] };
}

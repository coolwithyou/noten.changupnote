import { CRITERION_DIMENSIONS, type MatchingProfileAnswerRequest } from "@cunote/contracts";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "cunote:matching-profile-draft:v1:";
const TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_BYTES = 100_000;
const MAX_ANSWERS = 200;

export function profileDraftStorage(): DraftStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function readProfileDraft(storage: DraftStorage | null, bizNo: string, now = Date.now()): MatchingProfileAnswerRequest[] {
  if (!/^\d{10}$/.test(bizNo)) return [];
  try {
    const raw = storage?.getItem(PREFIX + bizNo);
    if (!raw || raw.length > MAX_BYTES) return [];
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || draft.bizNo !== bizNo || !Number.isFinite(draft.savedAt)
      || draft.savedAt > now || now - draft.savedAt >= TTL_MS
      || !Array.isArray(draft.answers) || draft.answers.length > MAX_ANSWERS
      || !draft.answers.every(isAnswer)) {
      storage?.removeItem(PREFIX + bizNo);
      return [];
    }
    return draft.answers;
  } catch { return []; }
}

export function writeProfileDraft(storage: DraftStorage | null, bizNo: string, answers: readonly MatchingProfileAnswerRequest[], now = Date.now()): boolean {
  if (!storage || !/^\d{10}$/.test(bizNo) || answers.length > MAX_ANSWERS || !answers.every(isAnswer)) return false;
  try {
    const raw = JSON.stringify({ version: 1, bizNo, savedAt: now, answers });
    if (raw.length > MAX_BYTES) return false;
    storage.setItem(PREFIX + bizNo, raw);
    return true;
  } catch { return false; }
}

export function clearProfileDraft(storage: DraftStorage | null, bizNo: string): void {
  try { storage?.removeItem(PREFIX + bizNo); } catch { /* 보관 불가가 회사 저장 성공을 바꾸지 않는다. */ }
}

function isAnswer(value: unknown): value is MatchingProfileAnswerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as MatchingProfileAnswerRequest;
  if (!CRITERION_DIMENSIONS.includes(answer.field)) return false;
  if (answer.mode !== undefined && answer.mode !== "merge" && answer.mode !== "replace") return false;
  if (answer.unknown !== undefined && typeof answer.unknown !== "boolean") return false;
  if (answer.range !== undefined) {
    const range = answer.range;
    if (!range || !Number.isFinite(range.min) || range.min < 0
      || (range.max !== null && (!Number.isFinite(range.max) || range.max < range.min))
      || !["krw", "people"].includes(range.unit)) return false;
  }
  return answer.unknown === true || answer.range !== undefined || Object.hasOwn(answer, "value");
}

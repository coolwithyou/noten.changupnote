import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import { applyAuthoringReadinessToWriteSupport } from "./annotateWriteSupport";

const readyDraft = card("ready-draft", "ai_draft", "ready");
const heldDraft = card("held-draft", "ai_draft", "held");
const unverifiedDraft = card("unverified-draft", "ai_draft", "unverified");
const legacyDraft = card("legacy-draft", "ai_draft");
const heldWebForm = card("held-web", "web_form_guide", "held");

const projected = applyAuthoringReadinessToWriteSupport([
  readyDraft,
  heldDraft,
  unverifiedDraft,
  legacyDraft,
  heldWebForm,
], new Set([
  sourceKey(readyDraft),
  sourceKey(heldDraft),
  sourceKey(unverifiedDraft),
]));

assert.deepEqual(projected.map((match) => [match.grantId, match.writeSupport]), [
  ["ready-draft", "template_fill"],
  ["held-draft", "manual_form"],
  ["unverified-draft", "manual_form"],
  ["legacy-draft", "unknown"],
  ["held-web", "unknown"],
], "자동 채움은 verified ready만, held/unverified 서식은 수동 편집만 허용한다");

assert.equal(
  applyAuthoringReadinessToWriteSupport([readyDraft], new Set())[0]?.writeSupport,
  "ai_draft",
  "verified ready의 작성형 문서는 초안 지원을 유지한다",
);
assert.equal(
  applyAuthoringReadinessToWriteSupport([heldDraft], new Set())[0]?.writeSupport,
  "unknown",
  "held이고 원본 서식도 없으면 자동 초안을 약속하지 않는다",
);

console.log("annotate write support readiness: ok");

function card(
  id: string,
  writeSupport: MatchCard["writeSupport"],
  readiness?: NonNullable<MatchCard["authoringReadiness"]>["status"],
): MatchCard {
  return {
    grantId: id,
    source: "bizinfo",
    sourceId: id,
    title: id,
    agency: null,
    status: "open",
    eligibility: "eligible",
    bucket: "now",
    fitScore: 100,
    supportAmount: { min: null, max: null, unit: "KRW", per: "기업" },
    benefits: [],
    applyEnd: null,
    dDay: null,
    ruleTrace: [],
    matchConfidence: 1,
    rulesetVer: "test",
    scoringVer: "test",
    authoringMode: writeSupport === "web_form_guide" ? "web_form" : "file_form",
    ...(readiness ? {
      authoringReadiness: {
        status: readiness,
        sourceDisposition: readiness === "ready" ? "ready" : readiness,
      },
    } : {}),
    writeSupport,
  };
}

function sourceKey(match: MatchCard): string {
  return `${match.source}:${match.sourceId}`;
}

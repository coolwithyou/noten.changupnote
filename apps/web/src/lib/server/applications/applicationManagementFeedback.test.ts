import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import {
  applicationManagementFromPayload,
  listRuntimeApplicationManagementFeedback,
  recordApplicationManagementFeedback,
} from "./applicationManagementFeedback";
import { buildApplicationPipeline } from "./pipeline";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const companyId = `company-${suffix}`;
const userId = `user-${suffix}`;
const grantId = `grant-${suffix}`;

recordApplicationManagementFeedback({
  companyId,
  userId,
  grantId,
  kind: "note",
  payload: {
    source: "application_pipeline",
    applicationStage: "recommended",
    reminderAt: "2026-08-04",
  },
}, "2026-07-15T00:00:00.000Z");

const all = listRuntimeApplicationManagementFeedback({ companyId, userId });
assert.equal(all.get(grantId)?.management?.reminderAt, "2026-08-04");
assert.equal(all.get(grantId)?.management?.applicationStage, "recommended");

const scoped = listRuntimeApplicationManagementFeedback({ companyId, userId, grantIds: [grantId] });
assert.equal(scoped.get(grantId)?.kind, "note");

const access: CompanyAccess = { companyId, userId, role: "owner", mode: "session" };
const match: MatchCard = {
  grantId,
  source: "kstartup",
  sourceId: `source-${suffix}`,
  title: "관리 피드백 회귀 테스트 공고",
  agency: null,
  status: "open",
  eligibility: "eligible",
  bucket: "now",
  fitScore: 100,
  supportAmount: { max: null, unit: "KRW", per: "기업" },
  benefits: [],
  applyEnd: "2026-08-10",
  dDay: 26,
  ruleTrace: [],
  matchConfidence: 1,
  rulesetVer: "test",
  scoringVer: "test",
  authoringMode: "unknown",
  writeSupport: "unknown",
};

const beforeClear = await buildApplicationPipeline({ access, matches: [match] });
assert.equal(beforeClear.items[0]?.stage, "recommended", "management 저장은 추천 단계를 유지해야 한다");
assert.equal(beforeClear.items[0]?.reminderAt, "2026-08-04");

const untrackedMatch: MatchCard = {
  ...match,
  grantId: `untracked-${suffix}`,
  sourceId: `untracked-source-${suffix}`,
  title: "사용자 행동이 없는 추천 공고",
};
const withoutRecommendationFlood = await buildApplicationPipeline({
  access,
  matches: [match, untrackedMatch],
});
assert.deepEqual(
  withoutRecommendationFlood.items.map((item) => item.grantId),
  [grantId],
  "사용자 행동이 없는 추천 공고는 신청 관리에 자동 편입되면 안 된다",
);

recordApplicationManagementFeedback({
  companyId,
  userId,
  grantId,
  kind: "note",
  payload: {
    source: "application_pipeline",
    applicationStage: "recommended",
    assigneeName: null,
    reminderAt: null,
    outcomeNote: null,
  },
}, "2026-07-15T00:01:00.000Z");

const cleared = listRuntimeApplicationManagementFeedback({ companyId, userId }).get(grantId);
assert.deepEqual(cleared?.management, {
  assigneeName: null,
  reminderAt: null,
  outcomeNote: null,
  applicationStage: "recommended",
});

const afterClear = await buildApplicationPipeline({ access, matches: [match] });
assert.equal(afterClear.items[0]?.stage, "recommended", "비어 있는 management 저장도 추천 단계를 유지해야 한다");
assert.equal(afterClear.items[0]?.reminderAt, null, "삭제한 리마인더가 되살아나면 안 된다");

assert.deepEqual(applicationManagementFromPayload({
  source: "application_pipeline",
  assigneeName: null,
  reminderAt: null,
  outcomeNote: null,
}), {
  assigneeName: null,
  reminderAt: null,
  outcomeNote: null,
  applicationStage: null,
}, "all-null payload는 무시가 아니라 명시적 삭제 스냅샷이어야 한다");

console.log("application-management-feedback: ok");

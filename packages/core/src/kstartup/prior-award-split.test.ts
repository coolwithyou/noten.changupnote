import assert from "node:assert/strict";
import { buildKStartupCriteria, normalizeKStartupAnnouncement } from "./normalize.js";

const row = {
  pbanc_sn: "prior-award-split",
  biz_pbanc_nm: "창업기업 지원",
  aply_excl_trgt_ctnt: "국세 체납 기업은 제외한다. 동일 과제에 중복 참여 중인 기업은 제외한다.",
  pbanc_rcpt_bgng_dt: "20260701",
  pbanc_rcpt_end_dt: "20260731",
};

const defaultOff = buildKStartupCriteria(row);
assert.equal(defaultOff.some((criterion) => criterion.dimension === "prior_award"), false, "기본값은 L1 미생성");
assert.equal(defaultOff.some((criterion) => criterion.dimension === "other" && criterion.kind === "exclusion"), true, "기본값은 residual 안전망 유지");

const enabled = buildKStartupCriteria(row, String(row.pbanc_sn), { priorAwardSplit: true });
const priorAward = enabled.find((criterion) => criterion.dimension === "prior_award");
assert.deepEqual(priorAward?.value, {
  scope: "self",
  self_kind: "same_project",
  channel: "general",
  labels: ["동일 과제에 중복 참여 중인 기업은 제외한다"],
});
assert.equal(priorAward?.source_span, "동일 과제에 중복 참여 중인 기업은 제외한다");
assert.equal(enabled.some((criterion) => criterion.dimension === "tax_compliance"), true, "기존 결격 분해 보존");
assert.equal(enabled.some((criterion) => criterion.dimension === "other" && criterion.kind === "exclusion"), false, "소비된 prior_award span은 placeholder 중복 없음");

const normalized = normalizeKStartupAnnouncement(row, {
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  priorAwardSplit: true,
});
assert.equal(normalized.criteria.some((criterion) => criterion.dimension === "prior_award"), true, "normalize 옵션이 build 경로까지 전달");

console.log("kstartup/prior-award-split.test.ts: all assertions passed");

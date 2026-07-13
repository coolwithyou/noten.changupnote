import assert from "node:assert/strict";
import { normalizeKStartupAnnouncement } from "./normalize.js";

const normalized = normalizeKStartupAnnouncement({
  pbanc_sn: "industry-projection",
  biz_pbanc_nm: "소프트웨어 기업 지원",
  aply_trgt: "일반기업",
  aply_trgt_ctnt: "소프트웨어 관련 기업을 지원합니다.",
  pbanc_rcpt_bgng_dt: "20260701",
  pbanc_rcpt_end_dt: "20260731",
}, { asOf: new Date("2026-07-12T00:00:00.000Z") });

assert.ok(normalized.grant.f_industries.includes("소프트웨어업"));
assert.ok(normalized.grant.f_industries.includes("582"));
assert.ok(normalized.grant.f_industries.includes("62"));
assert.equal(normalized.grant.audience, "company");

const excluded = normalizeKStartupAnnouncement({
  pbanc_sn: "industry-exclusion-projection",
  biz_pbanc_nm: "일반 지원",
  aply_excl_trgt_ctnt: "유흥주점업 및 사행시설 운영업은 지원 제외",
  pbanc_rcpt_bgng_dt: "20260701",
  pbanc_rcpt_end_dt: "20260731",
}, { asOf: new Date("2026-07-12T00:00:00.000Z") });
assert.equal(excluded.grant.f_industries.includes("유흥주점업"), false);

console.log("kstartup/projection.test.ts: all assertions passed");

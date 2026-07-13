import assert from "node:assert/strict";
import { normalizeKStartupAnnouncement } from "./normalize.js";
import type { KStartupAnnouncement } from "./types.js";

const asOf = new Date("2026-07-13T00:00:00.000Z");

assert.equal(normalize({ rcrt_prgs_yn: "N" }).grant.status, "closed");
assert.equal(normalize({ rcrt_prgs_yn: " n " }).grant.status, "closed");
assert.equal(normalize({ rcrt_prgs_yn: "Y" }).grant.status, "unknown");
assert.equal(normalize({ rcrt_prgs_yn: null }).grant.status, "unknown");
assert.equal(normalize({ rcrt_prgs_yn: "N", pbanc_rcpt_end_dt: "20261231" }).grant.status, "closed");
assert.equal(normalize({ rcrt_prgs_yn: "Y", pbanc_rcpt_end_dt: "20261231" }).grant.status, "open");

console.log("kstartup/status.test.ts: all assertions passed");

function normalize(overrides: Partial<KStartupAnnouncement>) {
  return normalizeKStartupAnnouncement({
    pbanc_sn: "status-test",
    biz_pbanc_nm: "모집상태 테스트",
    ...overrides,
  }, { asOf, collectedAt: asOf });
}

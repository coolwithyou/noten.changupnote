import assert from "node:assert/strict";
import {
  buildStartupConfirmationUrl,
  checkStartupConfirmation,
  parseStartupConfirmation,
} from "./check-startup-confirmation.js";

const payload = {
  currentCount: 3,
  data: {
    data: [
      {
        brno: "394-86-03207",
        crno: "1101111234567",
        ntrp_nm: "테스트 법인",
        ntrp_type_nm: "법인기업",
        confmdoc_isu_no: "2026-TEST",
        confmdoc_isu_dt: "20260101",
        confmdoc_expr_dt: "20261231",
      },
      {
        brno: "394-86-03207",
        confmdoc_isu_dt: "20270201",
        confmdoc_expr_dt: "20271231",
      },
      {
        brno: "111-11-11119",
        confmdoc_isu_dt: "20260101",
        confmdoc_expr_dt: "20261231",
      },
    ],
  },
};

const active = parseStartupConfirmation(payload, "3948603207", new Date("2026-07-12T00:00:00+09:00"));
assert.equal(active.state, "active");
assert.equal(active.record?.certificateNumber, "2026-TEST");
assert.equal(active.exactRecordCount, 2);

const future = parseStartupConfirmation(payload, "3948603207", new Date("2027-01-15T00:00:00+09:00"));
assert.equal(future.state, "future");

const expired = parseStartupConfirmation(payload, "3948603207", new Date("2028-01-01T00:00:00+09:00"));
assert.equal(expired.state, "expired");

assert.equal(
  parseStartupConfirmation(payload, "2222222222", new Date("2026-07-12T00:00:00+09:00")).state,
  "none",
);

const url = new URL(buildStartupConfirmationUrl("test-key", "394-86-03207"));
assert.equal(url.searchParams.get("cond[brno::EQ]"), "3948603207");
assert.equal(url.searchParams.get("returnType"), "json");

let requestedUrl = "";
const checked = await checkStartupConfirmation({
  serviceKey: "test-key",
  bizNo: "3948603207",
  now: new Date("2026-07-12T00:00:00+09:00"),
  fetchImpl: async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  },
});
assert.equal(checked.state, "active");
assert.match(requestedUrl, /getCorporateInformation/);

console.log("kstartup/check-startup-confirmation.test.ts: all assertions passed");

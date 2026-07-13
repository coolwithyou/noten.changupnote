import assert from "node:assert/strict";
import {
  buildMoefSubsidyAnnouncementUrl,
  fetchMoefSubsidyAnnouncementPage,
  parseMoefSubsidyAnnouncementResponse,
} from "./fetch.js";

const payload = {
  response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
    body: {
      pageNo: "1",
      numOfRows: "10",
      totalCount: "1",
      items: { item: {
        BSNSYEAR: "2026",
        DTLBZ_ID: "detail-1",
        PBLANC_NM: "스타트업 사업화 지원 공고",
        JRSD_NM: "중소벤처기업부",
        DLVPL_NM: "전담기관",
        RCEPT_BEGIN_DE: "20260701",
        RCEPT_END_DE: "20260731",
        SPORT_TRGET_CN: "창업기업",
        EXCL_TRGET_CN: "휴폐업 기업",
        PBLANC_POPUP_URL: "https://example.test/grant",
      } },
    },
  },
};
const parsed = parseMoefSubsidyAnnouncementResponse(payload);
assert.equal(parsed.items.length, 1);
assert.equal(parsed.items[0]?.supportTarget, "창업기업");
assert.equal(parsed.items[0]?.announcementUrl, "https://example.test/grant");
assert.throws(() => parseMoefSubsidyAnnouncementResponse({
  response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED" } },
}), /MOEF API error 30/);
const url = buildMoefSubsidyAnnouncementUrl("https://example.test/api", "decoded+/key", 2026, 2, 50);
assert.equal(url.includes("serviceKey=decoded%2B%2Fkey"), true);
assert.equal(url.includes("bsnsyear=2026"), true);
let requestedUrl = "";
const fetched = await fetchMoefSubsidyAnnouncementPage({
  serviceKey: "test-key",
  businessYear: 2026,
  fetchImpl: async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(payload), { status: 200 });
  },
});
assert.equal(fetched.totalCount, 1);
assert.equal(requestedUrl.includes("resultType=json"), true);
await assert.rejects(() => fetchMoefSubsidyAnnouncementPage({ serviceKey: "x", businessYear: 1999 }), /businessYear/);
console.log("moef/fetch.test.ts: all assertions passed");

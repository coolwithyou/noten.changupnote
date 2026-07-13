import assert from "node:assert/strict";
import {
  buildMsitAnnouncementUrl,
  fetchMsitAnnouncementPage,
  fetchMsitAnnouncementSnapshot,
  parseMsitAnnouncementResponse,
} from "./fetch.js";

const parsed = parseMsitAnnouncementResponse({
  response: {
    header: { resultCode: "00", resultMsg: "NORMAL_CODE" },
    body: {
      pageNo: 1,
      numOfRows: 10,
      totalCount: 1,
      items: { item: [{
        subject: "R&D 사업 공고",
        viewUrl: "https://www.msit.go.kr/example",
        pressDt: "2026-07-12",
        fileName: "공고문.hwp",
        fileUrl: "https://www.msit.go.kr/file.hwp",
      }] },
    },
  },
});
assert.equal(parsed.items.length, 1);
assert.equal(parsed.totalCount, 1);
assert.equal(parsed.items[0]?.fileName, "공고문.hwp");
assert.throws(() => parseMsitAnnouncementResponse({
  response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED" } },
}), /MSIT API error 30/);
const url = buildMsitAnnouncementUrl("https://example.test/api", "decoded+/key", 2, 50);
assert.equal(url.includes("decoded%2B%2Fkey"), true);
let requestedUrl = "";
const fetched = await fetchMsitAnnouncementPage({
  serviceKey: "test-key",
  fetchImpl: async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      response: { header: { resultCode: "00" }, body: { items: { item: parsed.items }, totalCount: 1 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
assert.equal(fetched.items.length, 1);
assert.equal(requestedUrl.includes("test-key"), true);
let pageRequests = 0;
const snapshot = await fetchMsitAnnouncementSnapshot({
  serviceKey: "test-key",
  numOfRows: 2,
  fetchImpl: async () => {
    pageRequests += 1;
    const items = pageRequests === 1 ? [parsed.items[0], parsed.items[0]] : [parsed.items[0]];
    return new Response(JSON.stringify({
      response: { header: { resultCode: "00" }, body: { items: { item: items }, totalCount: 3 } },
    }), { status: 200 });
  },
});
assert.equal(snapshot.items.length, 3);
assert.equal(snapshot.fetchedPages, 2);
assert.equal(snapshot.complete, true);
const truncated = await fetchMsitAnnouncementSnapshot({
  serviceKey: "test-key",
  numOfRows: 1,
  maxPages: 1,
  fetchImpl: async () => new Response(JSON.stringify({
    response: { header: { resultCode: "00" }, body: { items: { item: [parsed.items[0]] }, totalCount: 2 } },
  }), { status: 200 }),
});
assert.equal(truncated.complete, false);
await assert.rejects(() => fetchMsitAnnouncementSnapshot({ serviceKey: "x", maxPages: 0 }), /maxPages/);
console.log("msit/fetch.test.ts: all assertions passed");

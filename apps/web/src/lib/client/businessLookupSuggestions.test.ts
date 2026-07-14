import assert from "node:assert/strict";
import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";
import {
  removeBusinessLookupSuggestion,
  upsertBusinessLookupSuggestion,
} from "./businessLookupSuggestions";

function suggestion(bizNo: string, lastLookupAt: string): BusinessLookupSuggestion {
  return {
    id: `local:${bizNo}`,
    bizNo,
    bizNoFormatted: bizNo,
    bizNoMasked: "**********",
    companyName: null,
    industry: null,
    businessType: null,
    checkedAt: null,
    lastLookupAt,
    source: "local",
    cacheSource: "client_storage",
  };
}

const older = suggestion("1111111111", "2026-07-14T00:00:00.000Z");
const newer = suggestion("2222222222", "2026-07-15T00:00:00.000Z");

assert.deepEqual(
  removeBusinessLookupSuggestion([newer, older], "111-11-11111").map((item) => item.bizNo),
  ["2222222222"],
  "formatted business number removes the matching local suggestion",
);

assert.deepEqual(
  upsertBusinessLookupSuggestion([older, newer], suggestion("1111111111", "2026-07-16T00:00:00.000Z"))
    .map((item) => item.bizNo),
  ["1111111111", "2222222222"],
  "a later lookup restores a previously removed number without duplicates",
);

console.log("business lookup suggestion helpers: ok");

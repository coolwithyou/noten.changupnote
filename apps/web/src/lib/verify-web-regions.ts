import assert from "node:assert/strict";
import {
  KOREA_REGION_CODE_BY_LABEL,
  KOREA_REGION_OPTIONS,
  regionCodeForLabel,
} from "./regions";

const labels = new Set(KOREA_REGION_OPTIONS.map((region) => region.label));
const codes = new Set(KOREA_REGION_OPTIONS.map((region) => region.code));

assert.equal(labels.size, KOREA_REGION_OPTIONS.length, "region labels must be unique");
assert.equal(codes.size, KOREA_REGION_OPTIONS.length, "region codes must be unique");
assert.equal(KOREA_REGION_CODE_BY_LABEL["경기"], "41");
assert.equal(KOREA_REGION_CODE_BY_LABEL["강원"], "42");
assert.equal(KOREA_REGION_CODE_BY_LABEL["전북"], "45");
assert.equal(regionCodeForLabel("전북"), "45");
assert.equal(regionCodeForLabel("없는지역"), undefined);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "web_region_unique_labels",
    "web_region_unique_codes",
    "web_region_core_code_alignment",
    "web_region_label_lookup",
  ],
  regions: KOREA_REGION_OPTIONS.length,
}, null, 2));

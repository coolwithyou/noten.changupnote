import assert from "node:assert/strict";
import { buildKStartupCriteria, normalizeKStartupAnnouncement } from "./normalize.js";
import type { KStartupAnnouncement } from "./types.js";

const row = {
  pbanc_sn: 179038,
  biz_pbanc_nm: "AX/LX Challenge",
  supt_regin: "서울",
  biz_enyy: "예비창업자,1년미만,2년미만,3년미만,5년미만,7년미만,10년미만",
  biz_trgt_age: "만 20세 이상 ~ 만 39세 이하",
  aply_trgt_ctnt: "AX Challenge: Vertical AI Agent (산업군 무관). 법인 설립 3년차 미만은 우대조건이며 해당하지 않아도 지원 가능합니다.",
} as KStartupAnnouncement;

for (const criteria of [
  buildKStartupCriteria(row),
  normalizeKStartupAnnouncement(row).criteria,
]) {
  assert.equal(criteria.some((criterion) =>
    ["supt_regin", "biz_enyy", "biz_trgt_age"].includes(criterion.source_field ?? "")), false);
  assert.equal(criteria.some((criterion) =>
    criterion.dimension === "biz_age" && criterion.operator === "lte"), false);
}

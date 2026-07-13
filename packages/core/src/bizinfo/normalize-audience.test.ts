import assert from "node:assert/strict";
import { normalizeBizInfoProgram } from "./normalize.js";

const company = normalizeBizInfoProgram({
  pblancId: "audience-company",
  pblancNm: "수출 지원",
  trgetNm: "중소기업",
}, [], { asOf: new Date("2026-07-12T00:00:00.000Z") });
assert.equal(company.grant.audience, "company");

const individual = normalizeBizInfoProgram({
  pblancId: "audience-individual",
  pblancNm: "교육생 모집",
  bsnsSumryCn: "만 19세 이상 일반인을 대상으로 교육생을 모집합니다.",
}, [], { asOf: new Date("2026-07-12T00:00:00.000Z") });
assert.equal(individual.grant.audience, "individual");

console.log("bizinfo/normalize-audience.test.ts: all assertions passed");

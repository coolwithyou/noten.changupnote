import assert from "node:assert/strict";
import { canApplySavedWritingToField, assertWritingApplicationCurrent } from "./writingFieldApplication";
const bound = { status: "unique", targetKind: "table_cell_text", beforeText: "" };
// Long-text form fields resolve to the existing guarded whole-cell region transaction.
const region = { ...bound, targetKind: "table_cell_region" };
assert.equal(canApplySavedWritingToField(region, null, "검토한 기업 소개 문안"), true);
assert.equal(canApplySavedWritingToField({ ...region, beforeText: "\n  \n" }, null, "검토한 기업 소개 문안"), true);
assert.equal(canApplySavedWritingToField({ ...region, beforeText: "※ 작성 예시" }, "※ 작성 예시", "검토한 문안"), true);
for(const binding of [
  { ...region, status: "ambiguous" }, { ...region, status: "missing" }, { ...region, status: "resolving" },
  { status: region.status, targetKind: region.targetKind }, { ...region, beforeText: "이미 작성한 회사 내용\n다음 문단" },
  { ...region, beforeText: "(향후 1년 이내)" }, { ...region, beforeText: "-단기(1년내)/중기/장기" },
  { ...region, targetKind: "body_paragraph_text" }, { ...region, targetKind: "unknown_region" },
]) assert.equal(canApplySavedWritingToField(binding, null, "검토한 문안"), false);
assert.equal(canApplySavedWritingToField(region, null, "문".repeat(4000)), true);
assert.equal(canApplySavedWritingToField(region, null, "문".repeat(4001)), false);
assert.equal(canApplySavedWritingToField(region, null, "  "), false);
assert.equal(canApplySavedWritingToField({...region,beforeText:"기존 작성 내용"},null,"검토한 문안",{allowReviewedOverwrite:true}),true);
for(const binding of [{...region,status:"ambiguous"},{...region,targetKind:"body_paragraph_text"}]) assert.equal(canApplySavedWritingToField(binding,null,"문안",{allowReviewedOverwrite:true}),false);
const application={fieldId:"field",beforeText:"기존 작성 내용",text:"검토한 문안",revision:2,requiresConfirmation:true,confirmed:false};
const saved={revision:2,text:application.text},binding={beforeText:application.beforeText,requiresConfirmation:true};
assert.throws(()=>assertWritingApplicationCurrent(application,saved,true,binding));
const confirmed={...application,confirmed:true};assert.doesNotThrow(()=>assertWritingApplicationCurrent(confirmed,saved,true,binding));
for(const stale of [{revision:3,text:saved.text},{revision:2,text:"다른 저장본"}]) assert.throws(()=>assertWritingApplicationCurrent(confirmed,stale,true,binding));
assert.throws(()=>assertWritingApplicationCurrent(confirmed,saved,true,{...binding,beforeText:"바뀐 원본"}));
assert.throws(()=>assertWritingApplicationCurrent(confirmed,saved,false,binding));
assert.throws(()=>assertWritingApplicationCurrent(confirmed,saved,true,null));
assert.equal(canApplySavedWritingToField(bound, null, "실제 회사 자료를 확인한 문안"), true);
assert.equal(canApplySavedWritingToField({ ...bound, beforeText: "※ 작성 예시" }, "※ 작성 예시", "작성한 문안"), true);
for (const binding of [undefined, { ...bound, status: "ambiguous" }, { ...bound, status: "missing" }, { ...bound, targetKind: "body_paragraph_text" }, { ...bound, beforeText: "이미 작성한 실제 사업 내용" }, { ...bound, beforeText: "우리는 작성 서비스를 운영합니다." }]) assert.equal(canApplySavedWritingToField(binding, null, "검토한 문안"), false);
assert.equal(canApplySavedWritingToField(bound, null, "문".repeat(4001)), false);
assert.equal(canApplySavedWritingToField(bound, null, "문".repeat(4000)), true);
assert.equal(canApplySavedWritingToField(bound, null, "  "), false);
console.log("saved writing field application admission passed");

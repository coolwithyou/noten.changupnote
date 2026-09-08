import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OWNED_PROFILE_NOTICE,
  OWNED_PROFILE_SAVED_NOTICE,
  profileDrawerReducer,
  type ProfileDrawerState,
} from "./MatchResultsExperience";

const initialState = (): ProfileDrawerState => ({
  open: false,
  enteredCompanyIds: new Set(),
});

let state = profileDrawerReducer(initialState(), {
  type: "company_loaded",
  companyId: "company-a",
  basicProfileMissing: true,
  confirmationEntry: false,
});
assert.equal(state.open, true, "처음 진입한 미완성 회사는 프로필을 자동으로 엽니다.");

state = profileDrawerReducer(state, { type: "set_open", open: false });
state = profileDrawerReducer(state, {
  type: "company_loaded",
  companyId: "company-a",
  basicProfileMissing: true,
  confirmationEntry: false,
});
assert.equal(state.open, false, "같은 회사의 저장 후 재조회는 닫은 프로필을 다시 열지 않습니다.");

state = profileDrawerReducer(state, { type: "set_open", open: true });
assert.equal(state.open, true, "버튼이나 해시를 통한 명시적 열기는 회사 진입 이력과 무관하게 동작합니다.");
state = profileDrawerReducer(state, { type: "set_open", open: false });

state = profileDrawerReducer(state, {
  type: "company_loaded",
  companyId: "company-b",
  basicProfileMissing: true,
  confirmationEntry: false,
});
assert.equal(state.open, true, "새 회사의 첫 미완성 진입은 한 번 자동으로 엽니다.");
state = profileDrawerReducer(state, { type: "set_open", open: false });
state = profileDrawerReducer(state, {
  type: "company_loaded",
  companyId: "company-a",
  basicProfileMissing: true,
  confirmationEntry: false,
});
assert.equal(state.open, false, "A-B-A 전환에서 이미 본 A는 다시 자동으로 열지 않습니다.");

let confirmationState = profileDrawerReducer(initialState(), {
  type: "company_loaded",
  companyId: "company-confirm",
  basicProfileMissing: true,
  confirmationEntry: true,
});
assert.equal(confirmationState.open, false, "공고 확인 진입에서는 프로필이 확인 시트를 가리지 않습니다.");
confirmationState = profileDrawerReducer(confirmationState, {
  type: "company_loaded",
  companyId: "company-confirm",
  basicProfileMissing: true,
  confirmationEntry: false,
});
assert.equal(confirmationState.open, false, "확인 답변 저장 뒤 같은 회사 재조회도 프로필을 열지 않습니다.");

let completedState = profileDrawerReducer(initialState(), {
  type: "company_loaded",
  companyId: "company-complete",
  basicProfileMissing: false,
  confirmationEntry: false,
});
completedState = profileDrawerReducer(completedState, {
  type: "company_loaded",
  companyId: "company-complete",
  basicProfileMissing: true,
  confirmationEntry: false,
});
assert.equal(completedState.open, false, "첫 진입 당시 완성된 회사도 이후 재조회에서 새 자동 열림을 만들지 않습니다.");

assert.match(OWNED_PROFILE_NOTICE, /직접 입력한 답변은 내 계정의 개인 매칭 정보로 저장/);
assert.match(OWNED_PROFILE_NOTICE, /다른 구성원과 공유되지 않습니다/);
assert.match(OWNED_PROFILE_SAVED_NOTICE, /직접 입력한 답변이 내 계정의 개인 매칭 정보로 저장/);
assert.match(OWNED_PROFILE_SAVED_NOTICE, /다른 구성원과 공유되지 않습니다/);

const source = readFileSync(new URL("./MatchResultsExperience.tsx", import.meta.url), "utf8");
const loaderStart = source.indexOf("const loadCompanyMatching = useCallback");
const loaderEnd = source.indexOf("const loadTeaser = useCallback", loaderStart);
const loader = source.slice(loaderStart, loaderEnd);
const responseIndex = loader.indexOf("await loadOwnedMatching(id)");
const staleGuardIndex = loader.indexOf("if (seq !== requestSeqRef.current) return;");
const acceptIndex = loader.indexOf("acceptOwnedMatching(result)");
const profileDecisionIndex = loader.indexOf('type: "company_loaded"');
const catchIndex = loader.indexOf("} catch (caught)");
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, "회사 매칭 loader를 찾을 수 있어야 합니다.");
assert.ok(
  responseIndex >= 0 && responseIndex < staleGuardIndex && staleGuardIndex < acceptIndex && acceptIndex < profileDecisionIndex,
  "성공 응답은 stale guard를 통과한 뒤에만 회사 상태와 프로필 진입 이력을 반영해야 합니다.",
);
assert.ok(profileDecisionIndex < catchIndex, "실패 경로는 회사 프로필 진입 이력을 소비하면 안 됩니다.");
assert.equal(
  loader.slice(catchIndex).includes('type: "company_loaded"'),
  false,
  "catch 경로에는 회사 프로필 진입 처리가 없어야 합니다.",
);

console.log("match results profile drawer: per-company entry, explicit open, privacy copy and stale guard passed");

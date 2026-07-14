import assert from "node:assert/strict";
import { selectVisibleLoginMethods } from "./loginPresentation";

const methods = selectVisibleLoginMethods([
  { id: "demo", name: "Demo", kind: "credentials" },
  { id: "password", name: "이메일", kind: "credentials" },
  { id: "google", name: "Google", kind: "oauth" },
  { id: "kakao", name: "Kakao", kind: "oauth" },
  { id: "naver", name: "Naver", kind: "oauth" },
]);

assert.equal(methods.hasPassword, true);
assert.deepEqual(methods.oauthProviders.map((provider) => provider.id), ["google", "kakao", "naver"]);

const unavailable = selectVisibleLoginMethods([
  { id: "demo", name: "Demo", kind: "credentials" },
  { id: "google", name: "Google", kind: "oauth" },
]);

assert.equal(unavailable.hasPassword, false);
assert.deepEqual(unavailable.oauthProviders.map((provider) => provider.id), ["google"]);

console.log("login presentation verified");

import assert from "node:assert/strict";
import { profileSourceHelp } from "./profileSourceHelp";

const official = { sourceKind: "authoritative_api" as const, sourceLabel: "공식 확인", asOf: "2026-09-05T16:00:00Z", completeness: "complete" as const };
const help = profileSourceHelp(official)!;
assert.match(help.message, /직접 덮어쓸 수 없습니다/);
assert.match(help.asOf, /2026.*09.*06/);
assert.equal(help.href, "/support/source-corrections");
assert.match(profileSourceHelp({ ...official, completeness: "partial" })!.message, /일부만/);
assert.equal(profileSourceHelp({ ...official, asOf: "invalid" })!.asOf, "기준일 확인 필요");
assert.equal(profileSourceHelp({ ...official, sourceKind: "public_registry", sourceLabel: null })!.source, "공개명단");
assert.equal(profileSourceHelp({ ...official, sourceKind: "self_declared" }), null);
assert.equal(profileSourceHelp({ ...official, sourceKind: null }), null);
console.log("profile source help: provenance, partial/complete, KST and privacy-safe correction link passed");

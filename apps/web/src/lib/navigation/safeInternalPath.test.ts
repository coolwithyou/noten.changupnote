import assert from "node:assert/strict";
import { safeInternalPath } from "./safeInternalPath";

assert.equal(safeInternalPath("/applications?view=calendar#today"), "/applications?view=calendar#today");
assert.equal(safeInternalPath("https://evil.example/path"), null);
assert.equal(safeInternalPath("//evil.example/path"), null);
assert.equal(safeInternalPath("/\\evil.example"), null);
assert.equal(safeInternalPath(null), null);

console.log("safe internal path tests passed");

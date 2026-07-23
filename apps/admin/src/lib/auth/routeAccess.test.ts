import assert from "node:assert/strict";
import {
  canAccessAdminPath,
  defaultAdminPath,
} from "./routeAccess";

assert.equal(canAccessAdminPath("reviewer", "/review"), true);
assert.equal(canAccessAdminPath("reviewer", "/review/notice-id"), true);
assert.equal(canAccessAdminPath("reviewer", "/review/adjudicate"), false);
assert.equal(canAccessAdminPath("reviewer", "/credits"), false);
assert.equal(canAccessAdminPath("reviewer", "/registry-imports"), false);
assert.equal(canAccessAdminPath("reviewer", "/api/admin/flywheel"), false);
assert.equal(canAccessAdminPath("reviewer", "/api/admin/review/queue"), true);
assert.equal(canAccessAdminPath("reviewer", "/api/admin/review/adjudicate/item-id"), false);
assert.equal(canAccessAdminPath("admin", "/review/adjudicate"), true);
assert.equal(canAccessAdminPath("owner", "/api/admin/review/adjudicate/item-id"), true);
assert.equal(canAccessAdminPath("viewer", "/review"), false);
assert.equal(canAccessAdminPath("support", "/review"), false);
assert.equal(defaultAdminPath("reviewer"), "/review");
assert.equal(defaultAdminPath("admin"), "/");

console.log("admin route-access tests: ok");

import assert from "node:assert/strict";
import {
  grantSimulationCallbackPath,
  isGrantSimulationNavigationAllowed,
} from "../grantSimulationNavigation";

assert.equal(
  grantSimulationCallbackPath("grant/with space", "detail"),
  "/grants/grant%2Fwith%20space?adminPreview=1",
);
assert.equal(
  grantSimulationCallbackPath("grant/with space", "workspace"),
  "/grants/grant%2Fwith%20space/workspace?adminPreview=1",
);

assert.equal(
  isGrantSimulationNavigationAllowed("dev.changupnote.com", "owner"),
  true,
  "개발 도메인의 owner에게는 지원서 시뮬레이션 GNB를 보여야 합니다.",
);
assert.equal(isGrantSimulationNavigationAllowed("dev.changupnote.com:443", "owner"), true);
assert.equal(isGrantSimulationNavigationAllowed("127.0.0.1:4010", "owner"), true);
assert.equal(isGrantSimulationNavigationAllowed("localhost:4010", "owner"), true);

for (const role of ["admin", "reviewer", null] as const) {
  assert.equal(
    isGrantSimulationNavigationAllowed("dev.changupnote.com", role),
    false,
    `${String(role)} 역할에는 owner 전용 GNB를 보여주면 안 됩니다.`,
  );
}

for (const host of ["changupnote.com", "www.changupnote.com", "ops.changupnote.com", null]) {
  assert.equal(
    isGrantSimulationNavigationAllowed(host, "owner"),
    false,
    `${String(host)} 호스트에는 지원서 시뮬레이션 GNB를 보여주면 안 됩니다.`,
  );
}

console.log("admin grant simulation navigation: ok");

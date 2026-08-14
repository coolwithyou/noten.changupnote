import assert from "node:assert/strict";
import {
  resolveLabCostPolicy,
  shouldStopForSettledCost,
} from "./cost-policy";

{
  const policy = resolveLabCostPolicy({ transport: "claude-cli" });
  assert.deepEqual(policy, { kind: "subscription-telemetry-only" });
  assert.equal(
    shouldStopForSettledCost(policy, 1_000_000),
    false,
    "구독 실행의 명목 USD는 아무리 높아도 신규 착수를 중단하지 않는다",
  );
  console.log("✅ 구독 비용 정책 — 명목 USD는 telemetry 전용");
}

{
  const policy = resolveLabCostPolicy({ transport: "api", apiMaxCostUsd: 5 });
  assert.deepEqual(policy, { kind: "api-settled-usd-stop", maxUsd: 5 });
  assert.equal(shouldStopForSettledCost(policy, 4.999), false);
  assert.equal(
    shouldStopForSettledCost(policy, 5),
    true,
    "API guard는 완료 비용이 상한에 도달한 뒤 신규 착수를 중단한다",
  );
  console.log("✅ API 비용 정책 — 완료 비용 기준 soft stop 유지");
}

for (const apiMaxCostUsd of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(
    () => resolveLabCostPolicy({
      transport: "api",
      ...(apiMaxCostUsd !== undefined ? { apiMaxCostUsd } : {}),
    }),
    /apiMaxCostUsd 는 0보다 큰 유한한 숫자여야 합니다/,
  );
}
console.log("✅ API 비용 정책 — 누락·비정상 상한 fail-fast");

console.log("\ncost-policy 테스트 전부 통과");

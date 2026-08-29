import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const processor = readFileSync(new URL("./processor.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("./worker-cli.ts", import.meta.url), "utf8");
const launch = readFileSync(new URL("../analysis-lab/launch-batch-cli.ts", import.meta.url), "utf8");

for (const [name, source] of [["processor", processor], ["worker", worker]] as const) {
  assert.doesNotMatch(
    source,
    /applicationPrecompute|Kordoc|enqueueGrantApplication/u,
    `${name}는 신규 Kordoc 작업을 만들거나 claim하지 않는다`,
  );
}
assert.doesNotMatch(launch, /withApplicationRoundtrip:\s*false/u);
assert.doesNotMatch(launch, /with-kordoc|roundtrip-model/u);

console.log("deep processor Kordoc isolation tests: ok");

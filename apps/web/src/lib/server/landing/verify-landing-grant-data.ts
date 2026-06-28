import assert from "node:assert/strict";
import { closeCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { activeGrantApplyEndCutoff } from "../repositories/activeGrantFilter";
import { loadLandingGrantData } from "./landingGrantData";

loadMonorepoEnv();
process.env.CUNOTE_REPOSITORY_ADAPTER = "drizzle";

const asOf = new Date(readArg("asOf") ?? new Date().toISOString());

try {
  const data = await loadLandingGrantData({ asOf });
  const activeStatusTotal = data.stats.openCount + data.stats.upcomingCount + data.stats.unknownCount;

  assert.ok(data.stats.totalCount >= data.stats.activeCount, "total grant count should cover active count");
  assert.equal(data.stats.activeCount, activeStatusTotal, "active count should equal open/upcoming/unknown totals");
  assert.ok(data.stats.sourceCount > 0, "landing stats should include at least one source");
  assert.ok(data.banners.length > 0, "landing carousel should expose active grant banners");
  assert.ok(data.banners.length <= 8, "landing carousel should keep the configured banner limit");

  const applyEndCutoff = activeGrantApplyEndCutoff(asOf);
  for (const banner of data.banners) {
    assert.ok(["open", "upcoming", "unknown"].includes(banner.status), `banner should be active: ${banner.status}`);
    assert.ok(Array.isArray(banner.benefits), `banner benefits should be an array: ${banner.source}:${banner.sourceId}`);
    if (banner.applyEnd) {
      assert.ok(
        new Date(banner.applyEnd) >= applyEndCutoff,
        `banner applyEnd should be current or future: ${banner.applyEnd}`,
      );
    }
  }

  console.log(JSON.stringify({
    ok: true,
    asOf: asOf.toISOString(),
    stats: data.stats,
    banners: data.banners.map((banner) => ({
      source: banner.source,
      sourceId: banner.sourceId,
      title: banner.title,
      status: banner.status,
      dDay: banner.dDay,
      applyEnd: banner.applyEnd,
      supportAmountMax: banner.supportAmountMax,
      benefits: banner.benefits.map((benefit) => benefit.label),
    })),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

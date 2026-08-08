import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  adminGrantSimulationAttachmentHref,
  adminGrantSimulationDetailHref,
  adminGrantSimulationListHref,
  normalizeAdminGrantSimulationQuery,
  resolveDeepAnalysisState,
} from "./adminGrantSimulationList";

const defaultQuery = {
  q: "",
  status: "all" as const,
  deep: "all" as const,
  transport: "all" as const,
  kordoc: "all" as const,
  quick: "all" as const,
  attachments: "all" as const,
  page: 1,
};

assert.deepEqual(normalizeAdminGrantSimulationQuery({}), defaultQuery);
assert.deepEqual(
  normalizeAdminGrantSimulationQuery({
    q: "  AI ",
    status: "active",
    deep: "complete",
    transport: "subscription",
    kordoc: "review",
    quick: "ready",
    attachments: "has",
    page: "3",
  }),
  {
    q: "AI",
    status: "active",
    deep: "complete",
    transport: "subscription",
    kordoc: "review",
    quick: "ready",
    attachments: "has",
    page: 3,
  },
);
assert.deepEqual(
  normalizeAdminGrantSimulationQuery({
    status: "invalid",
    deep: "invalid",
    transport: "invalid",
    kordoc: "invalid",
    quick: "invalid",
    attachments: "invalid",
    page: "-5",
  }),
  defaultQuery,
);
assert.equal(
  adminGrantSimulationListHref({
    q: "AI 지원",
    status: "open",
    deep: "complete",
    transport: "subscription",
    kordoc: "review",
    quick: "ready",
    attachments: "has",
    page: 2,
  }),
  "/internal/review/grants?q=AI+%EC%A7%80%EC%9B%90&status=open&deep=complete&transport=subscription&kordoc=review&quick=ready&attachments=has&page=2",
);
assert.equal(
  adminGrantSimulationDetailHref("grant/with space"),
  "/grants/grant%2Fwith%20space?adminPreview=1",
);
assert.equal(
  adminGrantSimulationAttachmentHref("grant/with space", "attachment/id"),
  "/internal/review/api/grants/grant%2Fwith%20space/attachments/attachment%2Fid",
);

const subscriptionState = resolveDeepAnalysisState({
  localRun: {
    error: null,
    model: "claude-opus-5",
    promptVersion: "lab-deep-v9",
    transport: "claude-cli",
  },
  servingEvidence: null,
  latestDbRun: null,
  deepRunById: new Map(),
});
assert.deepEqual(subscriptionState, {
  status: "complete",
  transport: "subscription",
  model: "claude-opus-5",
  serving: false,
});

const productionState = resolveDeepAnalysisState({
  localRun: null,
  servingEvidence: { kind: "production_deep_run", deepAnalysisRunId: "deep-1" },
  latestDbRun: null,
  deepRunById: new Map([["deep-1", { id: "deep-1", status: "passed", model: "claude-sonnet" }]]),
});
assert.deepEqual(productionState, {
  status: "complete",
  transport: "api",
  model: "claude-sonnet",
  serving: true,
});

const pageSource = await readFile(
  new URL("../../app/internal/review/grants/page.tsx", import.meta.url),
  "utf8",
);
const globalCssSource = await readFile(
  new URL("../../app/globals.css", import.meta.url),
  "utf8",
);
const badgeSource = await readFile(
  new URL("../../components/ui/badge.tsx", import.meta.url),
  "utf8",
);
for (const filterName of ["status", "deep", "transport", "kordoc", "quick", "attachments"]) {
  assert.match(pageSource, new RegExp(`<FilterSelect name="${filterName}"`));
}
assert.match(pageSource, /<Suspense fallback=\{<GrantSimulationResultsSkeleton \/>\}>/);
assert.match(pageSource, /<GrantListCard key=/);
assert.match(pageSource, /<CardFooter className="justify-between gap-3">/);
assert.doesNotMatch(pageSource, /<Table>/);
assert.match(pageSource, /<DropdownMenu>/);
assert.match(pageSource, /density="compact"/);
assert.match(pageSource, /theme="shadcn-neutral"/);
assert.match(pageSource, /variant="admin"/);
assert.match(pageSource, /size="admin"/);
assert.match(pageSource, /variant="admin-primary"/);
assert.match(pageSource, /variant: "admin-outline", size: "admin"/);
assert.doesNotMatch(pageSource, /<StatusBlock\b/);
assert.doesNotMatch(pageSource, /render=\{<Link/);
assert.doesNotMatch(pageSource, /<select\b/);
assert.doesNotMatch(pageSource, /<details\b/);
assert.doesNotMatch(pageSource, /<Accordion\b/);
assert.match(globalCssSource, /\.review-shadcn-theme,/);
assert.match(globalCssSource, /\.review-shadcn-portal \{/);
assert.match(globalCssSource, /--primary: oklch\(0\.205 0 0\)/);
for (const variant of ["success", "info", "warning", "danger", "neutral", "violet"]) {
  assert.match(badgeSource, new RegExp(`"admin-${variant}"`));
}
assert.match(pageSource, /status === "open"\) return "admin-success"/);
assert.match(pageSource, /status === "upcoming"\) return "admin-info"/);
assert.match(pageSource, /status === "unknown"\) return "admin-warning"/);
assert.match(pageSource, /status === "complete"\) return "admin-success"/);
assert.match(pageSource, /status === "failed" \|\| status === "blocked"\) return "admin-danger"/);
assert.match(pageSource, /transport === "subscription" \? "admin-violet" : "admin-info"/);
const reviewThemeSource = globalCssSource.slice(globalCssSource.indexOf(".review-shadcn-theme,"));
assert.match(reviewThemeSource, /--info: oklch\(/);
assert.match(reviewThemeSource, /--studio-soft: oklch\(/);
assert.doesNotMatch(globalCssSource.slice(0, globalCssSource.indexOf(".review-shadcn-theme,")), /--info:/);

const listSource = await readFile(new URL("./adminGrantSimulationList.ts", import.meta.url), "utf8");
assert.match(
  listSource,
  /\) in \(\s*select[\s\S]*from \$\{schema\.grantRaw\}[\s\S]*union[\s\S]*from \$\{schema\.grantAttachmentArchives\}/,
);
assert.doesNotMatch(listSource, /exists \(\s*select 1 from \$\{schema\.grantRaw\}/);
assert.match(listSource, /stateSnapshot\s*\? Promise\.resolve\(null\)/);
assert.match(listSource, /const deepByGrant = new Map\(stateSnapshot\?\.deepByGrant\)/);

const rootLayoutSource = await readFile(new URL("../../app/layout.tsx", import.meta.url), "utf8");
assert.match(rootLayoutSource, /<html[\s\S]*suppressHydrationWarning/);

console.log("admin grant simulation list contracts passed");

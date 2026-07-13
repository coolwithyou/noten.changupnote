import { createHash } from "node:crypto";
import type { NormalizedGrant } from "@cunote/contracts";
import { resolveGrantExtractionManifest } from "../extraction/manifest.js";

export interface ExpandedGrantSelection<TPayload = unknown> {
  entries: Array<NormalizedGrant<TPayload>>;
  bySource: Record<string, number>;
  byReadinessGroup: Record<string, number>;
  dimensionCounts: Record<string, number>;
}

export function selectExpandedGrantReviewCandidates<TPayload>(input: {
  entries: Array<NormalizedGrant<TPayload>>;
  perSource?: number;
}): ExpandedGrantSelection<TPayload> {
  const perSource = input.perSource ?? 50;
  if (!Number.isInteger(perSource) || perSource < 10 || perSource > 500) throw new Error("perSource must be 10..500");
  const selected = ["kstartup", "bizinfo"].flatMap((source) => {
    const candidates = input.entries.filter((entry) => entry.grant.source === source);
    if (candidates.length < perSource) throw new Error(`${source}: requires ${perSource} candidates, found ${candidates.length}`);
    return selectSource(candidates, perSource);
  });
  return {
    entries: selected,
    bySource: histogram(selected.map((entry) => entry.grant.source)),
    byReadinessGroup: histogram(selected.map(readinessGroup)),
    dimensionCounts: histogram(selected.flatMap((entry) => [...new Set(entry.criteria.map((criterion) => criterion.dimension))])),
  };
}

function selectSource<TPayload>(entries: Array<NormalizedGrant<TPayload>>, quota: number): Array<NormalizedGrant<TPayload>> {
  const targets = {
    structured: Math.round(quota * 0.3),
    partial: Math.round(quota * 0.6),
    unstructured: quota - Math.round(quota * 0.3) - Math.round(quota * 0.6),
  };
  const selected: Array<NormalizedGrant<TPayload>> = [];
  const selectedKeys = new Set<string>();
  for (const group of ["structured", "partial", "unstructured"] as const) {
    const candidates = entries.filter((entry) => readinessGroup(entry) === group).sort(compareCandidates);
    for (const entry of candidates.slice(0, targets[group])) add(entry, selected, selectedKeys);
  }
  for (const entry of [...entries].sort(compareCandidates)) {
    if (selected.length >= quota) break;
    add(entry, selected, selectedKeys);
  }
  return selected.slice(0, quota);
}

function compareCandidates<TPayload>(left: NormalizedGrant<TPayload>, right: NormalizedGrant<TPayload>): number {
  return riskScore(right) - riskScore(left) || hashKey(left).localeCompare(hashKey(right));
}
function riskScore<TPayload>(entry: NormalizedGrant<TPayload>): number {
  const exclusion = entry.criteria.filter((criterion) => criterion.kind === "exclusion").length;
  const required = entry.criteria.filter((criterion) => criterion.kind === "required").length;
  const textOnly = entry.criteria.filter((criterion) => criterion.operator === "text_only").length;
  const dimensions = new Set(entry.criteria.map((criterion) => criterion.dimension)).size;
  const attachments = entry.raw.attachments?.length ?? 0;
  return exclusion * 8 + required * 3 + dimensions * 2 + textOnly + Math.min(attachments, 5);
}
function readinessGroup<TPayload>(entry: NormalizedGrant<TPayload>): "structured" | "partial" | "unstructured" {
  const readiness = resolveGrantExtractionManifest(entry).readiness;
  if (readiness === "reviewed" || readiness === "structured_unreviewed") return "structured";
  return readiness === "partial" ? "partial" : "unstructured";
}
function add<TPayload>(entry: NormalizedGrant<TPayload>, selected: Array<NormalizedGrant<TPayload>>, keys: Set<string>): void {
  const key = `${entry.grant.source}:${entry.grant.source_id}`;
  if (keys.has(key)) return;
  keys.add(key);
  selected.push(entry);
}
function hashKey<TPayload>(entry: NormalizedGrant<TPayload>): string {
  return createHash("sha256").update(`${entry.grant.source}:${entry.grant.source_id}`).digest("hex");
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

import { getAdminSql } from "@/lib/server/db/client";

const DEFAULT_GOLDEN_VER = "feedback-matching-candidates-v1";
const EVAL_RUNNER = "ops_admin_matching_eval_v1";
const ELIGIBILITIES = ["eligible", "conditional", "ineligible"] as const;
const GRANT_SOURCES = ["kstartup", "bizinfo", "bizinfo_event"] as const;

type Eligibility = typeof ELIGIBILITIES[number];
type GrantSource = typeof GRANT_SOURCES[number];

export type MatchingEvalStatus = "correct" | "wrong" | "missing_state" | "missing_grant" | "invalid_gold";

export interface AdminMatchingEvalResult {
  goldenVer: string;
  generatedAt: string;
  versionRefs: Record<string, string>;
  metrics: Record<string, number>;
  observations: MatchingEvalObservation[];
  evalRun: AdminMatchingEvalRun | null;
}

export interface AdminMatchingEvalRun {
  id: string;
  target: "matching";
  goldenVer: string;
  ts: string;
}

export interface MatchingEvalObservation {
  goldenId: string;
  ref: string;
  companyId: string | null;
  grantId: string | null;
  resolvedGrantId: string | null;
  expected: Eligibility | null;
  actual: Eligibility | null;
  status: MatchingEvalStatus;
  rulesetVer: string | null;
  scoringVer: string | null;
  missing: string[];
}

interface MatchingGoldenRow {
  id: string;
  ref: string;
  golden_ver: string;
  gold: Record<string, unknown>;
}

interface MatchStateRow {
  eligibility: Eligibility;
  ruleset_ver: string;
  scoring_ver: string;
}

export class AdminMatchingEvalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminMatchingEvalError";
  }
}

export async function runAdminMatchingEval(input: {
  goldenVer?: string | null;
  write?: boolean;
} = {}): Promise<AdminMatchingEvalResult> {
  const goldenVer = normalizeGoldenVer(input.goldenVer) ?? DEFAULT_GOLDEN_VER;
  const sql = getAdminSql();
  const goldenRows = await sql<MatchingGoldenRow[]>`
    select id, ref, golden_ver, gold
    from golden_set
    where kind = 'matching'
      and golden_ver = ${goldenVer}
    order by id desc
    limit 500
  `;

  const observations: MatchingEvalObservation[] = [];
  for (const row of goldenRows) {
    observations.push(await evaluateGoldenRow(row));
  }

  const metrics = computeMatchingEvalMetrics(observations);
  const versionRefs = buildMatchingEvalVersionRefs(observations, goldenVer);
  let evalRun: AdminMatchingEvalRun | null = null;

  if (input.write) {
    if (metrics.total === 0) {
      throw new AdminMatchingEvalError("matching_eval_empty", "평가할 matching 골든셋이 없습니다.", 400);
    }
    const created = await sql<{ id: string; target: string; golden_ver: string; ts: Date }[]>`
      insert into eval_runs (target, version_refs, metrics, golden_ver)
      values ('matching', ${JSON.stringify(versionRefs)}::jsonb, ${JSON.stringify(metrics)}::jsonb, ${goldenVer})
      returning id, target, golden_ver, ts
    `;
    const row = created[0];
    if (!row || row.target !== "matching") {
      throw new AdminMatchingEvalError("matching_eval_insert_failed", "평가 실행 결과를 저장하지 못했습니다.", 500);
    }
    evalRun = {
      id: row.id,
      target: "matching",
      goldenVer: row.golden_ver,
      ts: row.ts.toISOString(),
    };
  }

  return {
    goldenVer,
    generatedAt: new Date().toISOString(),
    versionRefs,
    metrics,
    observations,
    evalRun,
  };
}

export function computeMatchingEvalMetrics(observations: readonly MatchingEvalObservation[]): Record<string, number> {
  const total = observations.length;
  const invalidGold = countStatus(observations, "invalid_gold");
  const missingGrant = countStatus(observations, "missing_grant");
  const missingState = countStatus(observations, "missing_state");
  const correct = countStatus(observations, "correct");
  const wrong = countStatus(observations, "wrong");
  const validGold = total - invalidGold;
  const evaluable = correct + wrong;
  const metrics: Record<string, number> = {
    total,
    validGold,
    invalidGold,
    missingGrant,
    missingState,
    evaluable,
    correct,
    wrong,
    coverage: ratio(evaluable, validGold),
    accuracy: ratio(correct, evaluable),
  };

  for (const eligibility of ELIGIBILITIES) {
    const expected = observations.filter((item) => item.expected === eligibility && item.actual !== null).length;
    const predicted = observations.filter((item) => item.actual === eligibility).length;
    const truePositive = observations.filter((item) => item.expected === eligibility && item.actual === eligibility).length;
    metrics[`${eligibility}Expected`] = expected;
    metrics[`${eligibility}Predicted`] = predicted;
    metrics[`${eligibility}TruePositive`] = truePositive;
    metrics[`${eligibility}Precision`] = ratio(truePositive, predicted);
    metrics[`${eligibility}Recall`] = ratio(truePositive, expected);
  }

  const classRecallPass = ELIGIBILITIES.every((eligibility) => {
    const expected = metrics[`${eligibility}Expected`] ?? 0;
    const recall = metrics[`${eligibility}Recall`] ?? 0;
    return expected === 0 || recall === 1;
  });
  metrics.gateCoveragePass = validGold > 0 && metrics.coverage === 1 ? 1 : 0;
  metrics.gateAccuracyPass = evaluable > 0 && metrics.accuracy === 1 ? 1 : 0;
  metrics.gateClassRecallPass = classRecallPass ? 1 : 0;
  metrics.gatePass = metrics.gateCoveragePass === 1 && metrics.gateAccuracyPass === 1 && metrics.gateClassRecallPass === 1 ? 1 : 0;
  return metrics;
}

export function buildMatchingEvalVersionRefs(
  observations: readonly MatchingEvalObservation[],
  goldenVer: string,
): Record<string, string> {
  return {
    runner: EVAL_RUNNER,
    evalSchemaVer: "matching_eval_metrics_v1",
    goldenVer,
    rulesetVer: uniqueVersion(observations.map((item) => item.rulesetVer)),
    scoringVer: uniqueVersion(observations.map((item) => item.scoringVer)),
  };
}

async function evaluateGoldenRow(row: MatchingGoldenRow): Promise<MatchingEvalObservation> {
  const expected = eligibilityValue(row.gold.expected);
  const companyId = uuidValue(row.gold.companyId);
  const grantId = stringValue(row.gold.grantId);
  const missing: string[] = [];
  if (!companyId) missing.push("companyId");
  if (!grantId) missing.push("grantId");
  if (!expected) missing.push("expected");

  if (!companyId || !grantId || !expected) {
    return observation(row, { companyId, grantId, expected, status: "invalid_gold", missing });
  }

  const resolvedGrantId = await resolveGrant(grantId);
  if (!resolvedGrantId) {
    return observation(row, {
      companyId,
      grantId,
      expected,
      status: "missing_grant",
      missing: ["resolvedGrantId"],
    });
  }

  const matchState = await getAdminSql()<MatchStateRow[]>`
    select eligibility, ruleset_ver, scoring_ver
    from match_state
    where company_id = ${companyId}
      and grant_id = ${resolvedGrantId}
    limit 1
  `;
  const state = matchState[0];
  if (!state) {
    return observation(row, {
      companyId,
      grantId,
      resolvedGrantId,
      expected,
      status: "missing_state",
      missing: ["matchState"],
    });
  }

  return observation(row, {
    companyId,
    grantId,
    resolvedGrantId,
    expected,
    actual: state.eligibility,
    status: state.eligibility === expected ? "correct" : "wrong",
    rulesetVer: state.ruleset_ver,
    scoringVer: state.scoring_ver,
  });
}

async function resolveGrant(grantId: string): Promise<string | null> {
  if (uuidValue(grantId)) return grantId;
  const parsed = parseGrantKey(grantId);
  const sql = getAdminSql();
  const rows = parsed
    ? await sql<{ id: string }[]>`
      select id from grants where source = ${parsed.source} and source_id = ${parsed.sourceId} limit 1
    `
    : await sql<{ id: string }[]>`
      select id from grants where source_id = ${grantId} limit 1
    `;
  return rows[0]?.id ?? null;
}

function observation(
  row: MatchingGoldenRow,
  values: Partial<MatchingEvalObservation> & Pick<MatchingEvalObservation, "companyId" | "grantId" | "expected" | "status">,
): MatchingEvalObservation {
  return {
    goldenId: row.id,
    ref: row.ref,
    companyId: values.companyId,
    grantId: values.grantId,
    resolvedGrantId: values.resolvedGrantId ?? null,
    expected: values.expected,
    actual: values.actual ?? null,
    status: values.status,
    rulesetVer: values.rulesetVer ?? null,
    scoringVer: values.scoringVer ?? null,
    missing: values.missing ?? [],
  };
}

function countStatus(observations: readonly MatchingEvalObservation[], status: MatchingEvalStatus): number {
  return observations.filter((item) => item.status === status).length;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(6));
}

function uniqueVersion(values: Array<string | null>): string {
  const unique = new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));
  if (unique.size === 0) return "none";
  if (unique.size === 1) return [...unique][0] ?? "none";
  return `mixed:${unique.size}`;
}

function normalizeGoldenVer(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseGrantKey(value: string): { source: GrantSource; sourceId: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const source = value.slice(0, separator);
  const sourceId = value.slice(separator + 1);
  if (!isGrantSource(source) || sourceId.length === 0) return null;
  return { source, sourceId };
}

function isGrantSource(value: string): value is GrantSource {
  return GRANT_SOURCES.includes(value as GrantSource);
}

function eligibilityValue(value: unknown): Eligibility | null {
  return ELIGIBILITIES.includes(value as Eligibility) ? value as Eligibility : null;
}

function uuidValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

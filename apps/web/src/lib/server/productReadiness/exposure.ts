import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { GrantCriterion, MatchCard, NormalizedGrant } from "@cunote/contracts";
import { grantKey, isNonMatchingApplicationCriterion } from "@cunote/core";
import { getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { isPromotionItemServingEligible } from "../analysis-serving/promotionServing";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import type { PromotionGrantSnapshot } from "../analysis-serving/promotionSnapshot";

const MAX_AGE_MS = 15 * 60_000;
interface ExposureBinding { version: 1; itemId: string; grantId: string; companyId: string; userId: string; issuedAt: number }
interface Dependencies { db?: CunoteDb; secret?: string; enabled?: boolean; now?: Date }
export function productExposureEnabled() { return process.env.CUNOTE_PRODUCT_EXPOSURE_ENABLED === "true"; }
function secretFor(input: Dependencies): string { return input.secret ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? ""; }
function enabled(input: Dependencies): boolean { return input.enabled ?? productExposureEnabled(); }

export async function annotateProductExposure(cards: MatchCard[], input: { companyId: string; userId: string; grants: NormalizedGrant[] }): Promise<MatchCard[]> {
  if (!productExposureEnabled()) return cards;
  try {
    const tokens = await issueProductExposureTokens({ ...input, displayedGrantIds: cards.map((card) => card.grantId) });
    return cards.map((card) => {
      const exposureToken = tokens.get(card.grantId);
      return exposureToken ? { ...card, exposureToken } : card;
    });
  } catch { return cards; } // 관측 장애는 기본 여정을 차단하지 않으며 미관측을 0초로 보정하지 않는다.
}

/** 결과의 실제 criterion 집합이 최신 승격 snapshot과 같을 때만 노출 영수증을 발급한다. */
export async function issueProductExposureTokens(input: {
  companyId: string; userId: string; grants: NormalizedGrant[]; displayedGrantIds: string[];
}, dependencies: Dependencies = {}): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const secret = secretFor(dependencies);
  if (!enabled(dependencies) || secret.length < 32) return tokens;
  const displayed = new Set(input.displayedGrantIds);
  const grants = input.grants.filter((entry) => entry.grant.id && displayed.has(grantKey(entry.grant)));
  if (!grants.length || grants.length > 100) return tokens;
  const db = dependencies.db ?? getCunoteDb();
  const rows = await db.select({
    itemId: schema.analysisLabPromotionItems.id, grantId: schema.analysisLabPromotionItems.grantId,
    runId: schema.analysisLabPromotionItems.runId, planSha256: schema.analysisLabPromotionItems.planSha256,
    deepAnalysisRunId: schema.analysisLabPromotionItems.deepAnalysisRunId,
    releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
    manifest: schema.analysisLabPromotionReleases.manifest,
    afterSnapshot: schema.analysisLabPromotionItems.afterSnapshot,
    appliedAt: schema.analysisLabPromotionItems.appliedAt,
  }).from(schema.analysisLabPromotionItems).innerJoin(schema.analysisLabPromotionReleases,
    eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id))
    .where(and(inArray(schema.analysisLabPromotionItems.grantId, grants.map((entry) => entry.grant.id!)),
      eq(schema.analysisLabPromotionItems.status, "applied"), isNotNull(schema.analysisLabPromotionItems.appliedAt),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"])))
    .orderBy(desc(schema.analysisLabPromotionItems.appliedAt)).limit(401);
  if (rows.length > 400) return tokens; // 부분 이력으로 최신 revision을 추정하지 않는다.
  const latest = new Map<string, typeof rows[number]>();
  const tied = new Set<string>();
  for (const row of rows) {
    const previous = latest.get(row.grantId);
    if (!previous) latest.set(row.grantId, row);
    else if (previous.appliedAt?.getTime() === row.appliedAt?.getTime()) tied.add(row.grantId);
  }
  const now = (dependencies.now ?? new Date()).getTime();
  for (const entry of grants) {
    const row = latest.get(entry.grant.id!);
    if (!row || tied.has(row.grantId) || !row.appliedAt || row.appliedAt.getTime() > now || !isPromotionItemServingEligible(row)) continue;
    const snapshot = row.afterSnapshot as unknown as PromotionGrantSnapshot | null;
    if (!snapshot || !Array.isArray(snapshot.criteria) || snapshot.grantId !== row.grantId) continue;
    const criteria = snapshot.criteria.map((criterion) => ({
      id: criterion.id, dimension: criterion.dimension, operator: criterion.operator, value: criterion.value,
      kind: criterion.kind, confidence: criterion.confidence, source_span: criterion.sourceSpan ?? undefined,
      raw_text: criterion.rawText ?? undefined, parser_version: criterion.parserVersion ?? undefined,
      needs_review: criterion.needsReview, weight: criterion.weight ?? undefined,
    } as GrantCriterion)).filter((criterion) => !isNonMatchingApplicationCriterion(criterion));
    if (criteriaFingerprint(criteria) !== criteriaFingerprint(entry.criteria)) continue;
    tokens.set(grantKey(entry.grant), signExposureBinding({ version: 1, itemId: row.itemId, grantId: row.grantId,
      companyId: input.companyId, userId: input.userId, issuedAt: now }, secret));
  }
  return tokens;
}

function criteriaFingerprint(criteria: GrantCriterion[]): string {
  return sha256Canonical(criteria.map((criterion) => ({ id: criterion.id, dimension: criterion.dimension,
    operator: criterion.operator, value: criterion.value, kind: criterion.kind, confidence: criterion.confidence,
    weight: criterion.weight ?? null, needsReview: criterion.needs_review ?? false,
  })).sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")));
}

export function signExposureBinding(binding: ExposureBinding, secret: string): string {
  if (secret.length < 32) throw new Error("노출 영수증 서명 설정을 확인해주세요.");
  const body = Buffer.from(JSON.stringify(binding)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`product-exposure-v1:${body}`).digest("base64url")}`;
}

export function verifyExposureBinding(token: unknown, input: { companyId: string; userId: string; now: Date; secret: string }): ExposureBinding {
  const reject = () => Object.assign(new Error("노출 영수증이 만료되었거나 현재 회사와 다릅니다."), { status: 400, code: "invalid_exposure_receipt" });
  if (typeof token !== "string" || token.length > 2_000 || input.secret.length < 32) throw reject();
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature) || extra !== undefined) throw reject();
  const expected = createHmac("sha256", input.secret).update(`product-exposure-v1:${body}`).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw reject();
  let binding: ExposureBinding;
  try { binding = JSON.parse(Buffer.from(body, "base64url").toString()) as ExposureBinding; } catch { throw reject(); }
  if (!binding || binding.version !== 1 || binding.companyId !== input.companyId || binding.userId !== input.userId
    || !/^[a-f0-9-]{36}$/i.test(binding.itemId) || !/^[a-f0-9-]{36}$/i.test(binding.grantId)
    || !Number.isSafeInteger(binding.issuedAt) || binding.issuedAt > input.now.getTime()
    || input.now.getTime() - binding.issuedAt > MAX_AGE_MS) throw reject();
  return binding;
}

/** append-only 최초 수신. 클라이언트 시간·PII는 저장하지 않는다. 재시도는 최초 시각을 바꾸지 않는다. */
export async function recordProductExposure(input: { token: unknown; companyId: string; userId: string }, dependencies: Dependencies = {}): Promise<void> {
  if (!enabled(dependencies)) return;
  const now = dependencies.now ?? new Date();
  const binding = verifyExposureBinding(input.token, { ...input, now, secret: secretFor(dependencies) });
  const db = dependencies.db ?? getCunoteDb();
  // admission과 INSERT는 한 SQL snapshot이다. 철회된 승격의 늦은 이벤트는 새 승격에 붙이지 않는다.
  await db.execute(sql`insert into product_promotion_exposures (promotion_item_id, first_received_at)
    select item.id, ${now.toISOString()}::timestamptz from analysis_lab_promotion_items item
    join analysis_lab_promotion_releases release on release.id=item.release_db_id
    where item.id=${binding.itemId}::uuid and item.grant_id=${binding.grantId}::uuid
      and item.status='applied' and item.applied_at <= ${new Date(binding.issuedAt).toISOString()}::timestamptz
      and release.status in ('active','canary_passed')
    on conflict (promotion_item_id) do nothing`);
}

export async function loadProductExposureSummary(db = getCunoteDb()) {
  const rows = await db.execute(sql`select count(*)::int as observed_revisions,
    min(extract(epoch from (exposure.first_received_at-item.applied_at)))::float8 as minimum_seconds,
    max(extract(epoch from (exposure.first_received_at-item.applied_at)))::float8 as maximum_seconds
    from product_promotion_exposures exposure join analysis_lab_promotion_items item on item.id=exposure.promotion_item_id`);
  const row = rows[0]!;
  return { status: "observed" as const, observedRevisions: Number(row.observed_revisions),
    minimumSeconds: row.minimum_seconds === null ? null : Number(row.minimum_seconds),
    maximumSeconds: row.maximum_seconds === null ? null : Number(row.maximum_seconds),
    scope: "authenticated_matching_cards_since_instrumentation" as const,
    note: "카드가 뷰포트에 들어온 뒤 서버가 최초 신호를 받은 시각입니다. 과거 최초 노출·전체 사용자 노출·사용자의 실제 열람을 증명하지 않으며 네트워크 지연을 포함합니다." };
}
